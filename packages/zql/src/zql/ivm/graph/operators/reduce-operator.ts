import {assert} from 'shared/src/asserts.js';
import type {Primitive} from '../../../ast/ast.js';
import {genCached, genFlatMap} from '../../../util/iterables.js';
import type {Entry, Multiset} from '../../multiset.js';
import type {StringOrNumber} from '../../types.js';
import type {DifferenceStream} from '../difference-stream.js';
import {UnaryOperator} from './unary-operator.js';

/**
 * Applies a `reduce` function against a stream of values.
 *
 * Since `reduce` is a stateful operation, we need to keep track of all the
 * values that have been seen for a given key.
 *
 * If a given key has a member added or removed, we
 * re-run the reduction function against the entire set of
 * values for that key.
 *
 * In future iterations the reduction could also be made incremental.
 */
export class ReduceOperator<
  K extends Primitive,
  V extends object,
  O extends object = V,
> extends UnaryOperator<V, O> {
  /**
   * The set of all values that have been seen for a given key.
   *
   * Only positive multiplicities are expected to exist in this map.
   * If a negative multiplicity comes through the pipeline,
   * it reduces the multiplicity of the existing value in the map.
   */
  readonly #inIndex = new Map<K, Map<StringOrNumber, [V, number]>>();
  /**
   * Our prior reduction for a given key.
   *
   * This is used to retract reductions that are no longer valid.
   * E.g., if someone downstream of us is maintaining a count
   * then they'd need to know when a given reduction is no longer valid
   * so they can remove it from their count.
   */
  readonly #outIndex = new Map<K, O>();
  readonly #getValueIdentity;

  constructor(
    input: DifferenceStream<V>,
    output: DifferenceStream<O>,
    getValueIdentity: (value: V) => StringOrNumber,
    getGroupKey: (value: V) => K,
    f: (input: Iterable<V>) => O,
  ) {
    super(input, output, (_version, data) => this.#inner(data, getGroupKey, f));
    this.#getValueIdentity = getValueIdentity;
  }

  #inner = (
    data: Multiset<V>,
    getGroupKey: (value: V) => K,
    f: (input: Iterable<V>) => O,
  ) => {
    const keysToProcess = new Set<K>();

    for (const [value, mult] of data) {
      const key = getGroupKey(value);
      keysToProcess.add(key);
      this.#addToIndex(key, value, mult);
    }

    return genCached(
      genFlatMap(keysToProcess, k => {
        const dataIn = this.#inIndex.get(k);
        const existingOut = this.#outIndex.get(k);
        if (dataIn === undefined) {
          if (existingOut !== undefined) {
            // retract the reduction
            this.#outIndex.delete(k);
            return [[existingOut, -1]] as const;
          }
          return [];
        }

        const reduction = f(
          genFlatMap(dataIn, function* (mapEntry) {
            for (let i = 0; i < mapEntry[1][1]; i++) {
              yield mapEntry[1][0];
            }
          }),
        );
        const ret: Entry<O>[] = [];
        if (existingOut !== undefined) {
          // modified reduction
          ret.push([existingOut, -1]);
        }
        ret.push([reduction, 1]);
        this.#outIndex.set(k, reduction);
        return ret;
      }),
    );
  };

  #addToIndex(key: K, value: V, mult: number) {
    let existing = this.#inIndex.get(key);
    if (existing === undefined) {
      existing = new Map<string, [V, number]>();
      this.#inIndex.set(key, existing);
    }
    const valueIdentity = this.#getValueIdentity(value);
    const prev = existing.get(valueIdentity);
    if (prev === undefined) {
      existing.set(valueIdentity, [value, mult]);
    } else {
      const [v, m] = prev;
      const newMult = m + mult;
      assert(
        newMult >= 0,
        'Should not end up with a negative multiplicity when tracking all events for an item',
      );
      if (newMult === 0) {
        existing.delete(valueIdentity);
        if (existing.size === 0) {
          this.#inIndex.delete(key);
          return undefined;
        }
      } else {
        existing.set(valueIdentity, [v, newMult]);
      }
    }

    return existing;
  }
}
