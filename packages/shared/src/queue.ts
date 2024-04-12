import {resolver, type Resolver} from '@rocicorp/resolver';

/**
 * A Queue allows the consumers to await (possibly future) values,
 * and producers to await the consumption of their values.
 */
export class Queue<T> {
  // Consumers waiting for entries to be produced.
  readonly #consumers: Resolver<T>[] = [];
  // Produced entries waiting to be consumed.
  readonly #produced: {value: Promise<T>; consumed: () => void}[] = [];

  /** @returns A Promise that resolves when the value is consumed. */
  enqueue(value: T): Promise<void> {
    const consumer = this.#consumers.shift();
    if (consumer) {
      consumer.resolve(value);
      return Promise.resolve();
    }
    return this.#enqueueProduced(Promise.resolve(value));
  }

  /** @returns A Promise that resolves when the rejection is consumed. */
  enqueueRejection(reason?: unknown): Promise<void> {
    const consumer = this.#consumers.shift();
    if (consumer) {
      consumer.reject(reason);
      return Promise.resolve();
    }
    return this.#enqueueProduced(Promise.reject(reason));
  }

  #enqueueProduced(value: Promise<T>): Promise<void> {
    const {promise, resolve: consumed} = resolver<void>();
    this.#produced.push({value, consumed});
    return promise;
  }

  /** @returns A Promise that resolves to the next enqueued value. */
  dequeue(): Promise<T> {
    const produced = this.#produced.shift();
    if (produced) {
      produced.consumed();
      return produced.value;
    }
    const consumer = resolver<T>();
    this.#consumers.push(consumer);
    return consumer.promise;
  }

  /**
   * @returns The instantaneous number of outstanding values waiting to be
   *          dequeued. Note that if a value was enqueued while a consumer
   *          was waiting (with `await dequeue()`), the value is immediately
   *          handed to the consumer and the Queue's size remains 0.
   */
  size(): number {
    return this.#produced.length;
  }

  asAsyncIterable(cleanup = NOOP): AsyncIterable<T> {
    return {[Symbol.asyncIterator]: () => this.asAsyncIterator(cleanup)};
  }

  asAsyncIterator(cleanup = NOOP): AsyncIterator<T> {
    return {
      next: async () => {
        try {
          const value = await this.dequeue();
          return {value};
        } catch (e) {
          cleanup();
          throw e;
        }
      },
      return: value => {
        cleanup();
        return Promise.resolve({value, done: true});
      },
    };
  }
}

const NOOP = () => {};
