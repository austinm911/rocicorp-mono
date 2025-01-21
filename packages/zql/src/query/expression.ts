/* eslint-disable @typescript-eslint/no-explicit-any */
import {must} from '../../../shared/src/must.js';
import {
  toStaticParam,
  type Condition,
  type LiteralValue,
  type Parameter,
} from '../../../zero-protocol/src/ast.js';
import type {Schema} from '../../../zero-schema/src/builder/schema-builder.js';
import type {Operator} from './query.js';
import type {
  AvailableRelationships,
  DestTableName,
  GetFilterType,
  NoJsonSelector,
  PullTableSchema,
  Query,
} from './query.js';

export type ParameterReference = {
  [toStaticParam](): Parameter;
};

/**
 * A factory function that creates a condition. This is used to create
 * complex conditions that can be passed to the `where` method of a query.
 *
 * @example
 *
 * ```ts
 * const condition: ExpressionFactory<User> = ({and, cmp, or}) =>
 *   and(
 *     cmp('name', '=', 'Alice'),
 *     or(cmp('age', '>', 18), cmp('isStudent', '=', true)),
 *   );
 *
 * const query = z.query.user.where(condition);
 * ```
 */
export interface ExpressionFactory<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
> {
  (eb: ExpressionBuilder<TSchema, TTable>): Condition;
}

export class ExpressionBuilder<
  TSchema extends Schema,
  TTable extends keyof TSchema['tables'] & string,
> {
  readonly #exists: (
    relationship: string,
    cb?: (query: Query<TSchema, TTable>) => Query<TSchema, any>,
  ) => Condition;

  constructor(
    exists: (
      relationship: string,
      cb?: (query: Query<TSchema, TTable>) => Query<TSchema, any>,
    ) => Condition,
  ) {
    this.#exists = exists;
    this.exists = this.exists.bind(this);
  }

  get eb() {
    return this;
  }

  cmp<
    TSelector extends NoJsonSelector<PullTableSchema<TTable, TSchema>>,
    TOperator extends Operator,
  >(
    field: TSelector,
    op: TOperator,
    value:
      | GetFilterType<PullTableSchema<TTable, TSchema>, TSelector, TOperator>
      | ParameterReference,
  ): Condition;
  cmp<TSelector extends NoJsonSelector<PullTableSchema<TTable, TSchema>>>(
    field: TSelector,
    value:
      | GetFilterType<PullTableSchema<TTable, TSchema>, TSelector, '='>
      | ParameterReference,
  ): Condition;
  cmp(
    field: string,
    opOrValue: Operator | ParameterReference | LiteralValue,
    value?: ParameterReference | LiteralValue,
  ): Condition {
    return cmp(field, opOrValue, value);
  }

  cmpLit(
    left: ParameterReference | LiteralValue,
    op: Operator,
    right: ParameterReference | LiteralValue,
  ): Condition {
    return {
      type: 'simple',
      left: isParameterReference(left)
        ? left[toStaticParam]()
        : {type: 'literal', value: left},
      right: isParameterReference(right)
        ? right[toStaticParam]()
        : {type: 'literal', value: right},
      op,
    };
  }

  and = and;
  or = or;
  not = not;

  exists<TRelationship extends AvailableRelationships<TTable, TSchema>>(
    relationship: TRelationship,
    cb?: (
      query: Query<TSchema, DestTableName<TTable, TSchema, TRelationship>>,
    ) => Query<TSchema, any>,
  ): Condition {
    return this.#exists(relationship, cb);
  }
}

export function and(...conditions: (Condition | undefined)[]): Condition {
  const expressions = filterTrue(filterUndefined(conditions));

  if (expressions.length === 1) {
    return expressions[0];
  }

  if (expressions.some(isAlwaysFalse)) {
    return FALSE;
  }

  return {type: 'and', conditions: expressions};
}

export function or(...conditions: (Condition | undefined)[]): Condition {
  const expressions = filterFalse(filterUndefined(conditions));

  if (expressions.length === 1) {
    return expressions[0];
  }

  if (expressions.some(isAlwaysTrue)) {
    return TRUE;
  }

  return {type: 'or', conditions: expressions};
}

export function not(expression: Condition): Condition {
  switch (expression.type) {
    case 'and':
      return {
        type: 'or',
        conditions: expression.conditions.map(not),
      };
    case 'or':
      return {
        type: 'and',
        conditions: expression.conditions.map(not),
      };
    case 'correlatedSubquery':
      return {
        type: 'correlatedSubquery',
        related: expression.related,
        op: negateOperator(expression.op),
      };
    case 'simple':
      return {
        type: 'simple',
        op: negateOperator(expression.op),
        left: expression.left,
        right: expression.right,
      };
  }
}

export function cmp(
  field: string,
  opOrValue: Operator | ParameterReference | LiteralValue,
  value?: ParameterReference | LiteralValue,
): Condition {
  let op: Operator;
  if (value === undefined) {
    value = opOrValue;
    op = '=';
  } else {
    op = opOrValue as Operator;
  }

  return {
    type: 'simple',
    left: {type: 'column', name: field},
    right: isParameterReference(value)
      ? value[toStaticParam]()
      : {type: 'literal', value},
    op,
  };
}

function isParameterReference(
  value: ParameterReference | LiteralValue | null,
): value is ParameterReference {
  return (
    value !== null && typeof value === 'object' && (value as any)[toStaticParam]
  );
}

export const TRUE: Condition = {
  type: 'and',
  conditions: [],
};

const FALSE: Condition = {
  type: 'or',
  conditions: [],
};

function isAlwaysTrue(condition: Condition): boolean {
  return condition.type === 'and' && condition.conditions.length === 0;
}

function isAlwaysFalse(condition: Condition): boolean {
  return condition.type === 'or' && condition.conditions.length === 0;
}

export function flatten(
  type: 'and' | 'or',
  conditions: Condition[],
): Condition[] {
  const flattened: Condition[] = [];
  for (const c of conditions) {
    if (c.type === type) {
      flattened.push(...c.conditions);
    } else {
      flattened.push(c);
    }
  }

  return flattened;
}

const negateSimpleOperatorMap = {
  ['=']: '!=',
  ['!=']: '=',
  ['<']: '>=',
  ['>']: '<=',
  ['>=']: '<',
  ['<=']: '>',
  ['IN']: 'NOT IN',
  ['NOT IN']: 'IN',
  ['LIKE']: 'NOT LIKE',
  ['NOT LIKE']: 'LIKE',
  ['ILIKE']: 'NOT ILIKE',
  ['NOT ILIKE']: 'ILIKE',
  ['IS']: 'IS NOT',
  ['IS NOT']: 'IS',
} as const;

const negateOperatorMap = {
  ...negateSimpleOperatorMap,
  ['EXISTS']: 'NOT EXISTS',
  ['NOT EXISTS']: 'EXISTS',
} as const;

function negateOperator<OP extends keyof typeof negateOperatorMap>(
  op: OP,
): (typeof negateOperatorMap)[OP] {
  return must(negateOperatorMap[op]);
}

function filterUndefined<T>(array: (T | undefined)[]): T[] {
  return array.filter(e => e !== undefined);
}

function filterTrue(conditions: Condition[]): Condition[] {
  return conditions.filter(c => !isAlwaysTrue(c));
}

function filterFalse(conditions: Condition[]): Condition[] {
  return conditions.filter(c => !isAlwaysFalse(c));
}
