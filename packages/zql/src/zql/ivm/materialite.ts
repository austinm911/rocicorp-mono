// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore next.js is having issues finding the .d.ts
import type {PipelineEntity} from './types.js';
import {must} from 'shared/src/must.js';
import {SetSource} from './source/set-source.js';
import type {Ordering} from '../ast/ast.js';
import type {Source, SourceInternal} from './source/source.js';
import type {Version} from './types.js';

export type MaterialiteForSourceInternal = {
  readonly materialite: Materialite;
  nextVersion(): number;
  getVersion(): number;
  addDirtySource(source: SourceInternal): void;
};

export class Materialite {
  #version: Version;
  #dirtySources: Set<SourceInternal> = new Set();

  #currentTx: Version | null = null;
  #internal: MaterialiteForSourceInternal;

  constructor() {
    this.#version = 0;
    this.#internal = {
      materialite: this,
      getVersion: () => this.#version,
      nextVersion: () => {
        this.#version += 1;
        return this.#version;
      },
      addDirtySource: (source: SourceInternal) => {
        this.#dirtySources.add(source);
        // auto-commit if not in a transaction
        if (this.#currentTx === null) {
          this.#commit(true);
        }
      },
    };
  }

  newSetSource<T extends PipelineEntity>(order: Ordering, name: string) {
    return new SetSource<T>(this.#internal, order, name);
  }

  constructSource<T extends PipelineEntity>(
    ctor: (internal: MaterialiteForSourceInternal) => Source<T>,
  ) {
    return ctor(this.#internal);
  }

  /**
   * Run the provided lambda in a transaction.
   * Will be committed when the lambda exits
   * and all incremental computations that depend on modified inputs
   * will be run.
   *
   * An exception to this is in the case of nested transactions.
   * No incremental computation will run until the outermost transaction
   * completes.
   *
   * If the transaction throws, all pending inputs which were queued will be rolled back.
   * If a nested transaction throws, all transactions in the stack are rolled back.
   *
   * In this way, nesting transactions only exists to allow functions to be ignorant
   * of what transactions other functions that they call may create. It would be problematic
   * if creating transactions within transactions failed as it would preclude the use of
   * libraries that use transactions internally.
   */
  tx(fn: () => void) {
    if (this.#currentTx === null) {
      this.#currentTx = this.#version + 1;
    } else {
      // nested transaction
      // just run the function as we're already inside the
      // scope of a transaction that will handle rollback and commit.
      fn();
      return;
    }
    try {
      try {
        this._txBegin();
        fn();
      } catch (e) {
        this.#rollback();
        throw e;
      }
      this.#commit();
    } finally {
      this.#dirtySources.clear();
    }
  }

  protected _txBegin(): void {}

  protected _txCommit(): void {}

  protected _txRollback(): void {}

  #rollback() {
    this.#currentTx = null;
    this._txRollback();
    for (const source of this.#dirtySources) {
      source.onRollback();
    }
  }

  #commit(autoTx = false) {
    try {
      if (autoTx) {
        this.#currentTx = this.#version + 1;
        this._txBegin();
      }
      this.#version = must(this.#currentTx);
      this.#currentTx = null;
      for (const source of this.#dirtySources) {
        source.onCommitEnqueue(this.#version);
      }

      this._txCommit();
    } catch (e) {
      this.#rollback();
      throw e;
    }

    for (const source of this.#dirtySources) {
      source.onCommitted(this.#version);
    }
  }
}
