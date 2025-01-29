import {expect, expectTypeOf, test} from 'vitest';
import {schema} from '../../../zql/src/query/test/test-schemas.ts';
import type {CustomMutatorDefs, MakeCustomMutatorInterfaces} from './custom.ts';
import {zeroForTest} from './test-utils.ts';
import {nanoid} from '../util/nanoid.ts';
type Schema = typeof schema;

test('argument types are preserved on the generated mutator interface', () => {
  const mutators = {
    issue: {
      setTitle: (tx, {id, title}: {id: string; title: string}) =>
        tx.mutate.issue.update({id, title}),
      setProps: (
        tx,
        {
          id,
          title,
          status,
          assignee,
        }: {
          id: string;
          title: string;
          status: 'open' | 'closed';
          assignee: string;
        },
      ) =>
        tx.mutate.issue.update({
          id,
          title,
          closed: status === 'closed',
          ownerId: assignee,
        }),
    },
    nonTableNamespace: {
      doThing: (_tx, _a: {arg1: string; arg2: number}) => {
        throw new Error('not implemented');
      },
    },
  } satisfies CustomMutatorDefs<Schema>;

  type MutatorsInterface = MakeCustomMutatorInterfaces<Schema, typeof mutators>;
  expectTypeOf<MutatorsInterface>().toEqualTypeOf<{
    readonly issue: {
      readonly setTitle: (args: {id: string; title: string}) => void;
      readonly setProps: (args: {
        id: string;
        title: string;
        status: 'closed' | 'open';
        assignee: string;
      }) => void;
    };
    readonly nonTableNamespace: {
      readonly doThing: (args: {arg1: string; arg2: number}) => void;
    };
  }>();
});

test('custom mutators write to the local store', async () => {
  const z = zeroForTest({
    logLevel: 'debug',
    schema,
    mutators: {
      issue: {
        setTitle: async (tx, {id, title}: {id: string; title: string}) => {
          await tx.mutate.issue.update({id, title});
        },
        deleteTwoIssues: async (tx, {id1, id2}: {id1: string; id2: string}) => {
          await Promise.all([
            tx.mutate.issue.delete({id: id1}),
            tx.mutate.issue.delete({id: id2}),
          ]);
        },
        create: async tx => {
          await tx.mutate.issue.insert({
            id: nanoid(),
            title: '',
            closed: false,
            ownerId: '',
            description: '',
          });
        },
      },
      customNamespace: {
        clown: async (tx, id: string) => {
          await tx.mutate.issue.update({id, title: '🤡'});
        },
      },
    },
  });

  await z.mutate.issue.insert({
    id: '1',
    title: 'foo',
    closed: false,
    ownerId: '',
    description: '',
  });

  let issues = z.query.issue.run();
  expect(issues[0].title).toEqual('foo');

  await z.mutate.issue.setTitle({id: '1', title: 'bar'});
  issues = z.query.issue.run();
  expect(issues[0].title).toEqual('bar');

  await z.mutate.customNamespace.clown('1');
  issues = z.query.issue.run();
  expect(issues[0].title).toEqual('🤡');

  await z.mutate.issue.create();
  issues = z.query.issue.run();
  expect(issues.length).toEqual(2);

  await z.mutate.issue.deleteTwoIssues({id1: issues[0].id, id2: issues[1].id});
  issues = z.query.issue.run();
  expect(issues.length).toEqual(0);
});
