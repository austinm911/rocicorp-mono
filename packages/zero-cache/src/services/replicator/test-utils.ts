import {LogContext} from '@rocicorp/logger';
import {Database} from 'zqlite/src/db.js';
import {Pgoutput} from 'pg-logical-replication';
import {assert} from 'shared/src/asserts.js';
import {StatementRunner} from 'zero-cache/src/db/statements.js';
import {RowKey, RowValue} from 'zero-cache/src/types/row-key.js';
import {h32} from 'zero-cache/src/types/xxhash.js';
import {MessageProcessor} from './incremental-sync.js';

const NOOP = () => {};

export interface FakeReplicator {
  process(...msgs: Pgoutput.Message[]): void;

  processTransaction(
    finalLSN: string,
    ...msgs: (
      | Pgoutput.MessageInsert
      | Pgoutput.MessageDelete
      | Pgoutput.MessageUpdate
    )[]
  ): void;
}

export function fakeReplicator(lc: LogContext, db: Database): FakeReplicator {
  const messageProcessor = createMessageProcessor(db);
  return {
    process: (...msgs) => {
      for (const msg of msgs) {
        messageProcessor.processMessage(lc, '0/1', msg);
      }
    },

    processTransaction: (commitEndLsn, ...msgs) => {
      messageProcessor.processMessage(lc, '0/1', {
        tag: 'begin',
        commitLsn: null,
        commitTime: 0n,
        xid: 0,
      });
      for (const msg of msgs) {
        messageProcessor.processMessage(lc, '0/1', msg);
      }
      messageProcessor.processMessage(lc, '0/1', {
        tag: 'commit',
        flags: 0,
        commitLsn: null,
        commitEndLsn,
        commitTime: 0n,
      });
    },
  };
}

export function createMessageProcessor(
  db: Database,
  ack: (lsn: string) => void = NOOP,
  versions: () => void = NOOP,
  failures: (lc: LogContext, err: unknown) => void = NOOP,
): MessageProcessor {
  return new MessageProcessor(new StatementRunner(db), ack, versions, failures);
}

export class ReplicationMessages<
  TablesAndKeys extends Record<string, string | string[]>,
> {
  readonly #tables = new Map<string, Pgoutput.MessageRelation>();

  constructor(tablesAndKeys: TablesAndKeys) {
    for (const [table, k] of Object.entries(tablesAndKeys)) {
      const keys = typeof k === 'string' ? [k] : [...k];
      const relation = {
        tag: 'relation',
        relationOid: h32(table), // deterministic for snapshot-friendliness
        schema: 'public',
        name: table,
        replicaIdentity: 'default',
        columns: keys.map(name => ({
          flags: 1,
          name,
          typeOid: 23,
          typeMod: -1,
          typeSchema: null,
          typeName: null,
          parser: () => {},
        })),
        keyColumns: keys,
      } as const;
      this.#tables.set(table, relation);
    }
  }

  #relationOrFail(table: string): Pgoutput.MessageRelation {
    const relation = this.#tables.get(table);
    assert(relation); // Type parameters should guarantee this.
    return relation;
  }

  begin(commitLsn: string | null = null): Pgoutput.MessageBegin {
    return {tag: 'begin', commitLsn, commitTime: 0n, xid: 0};
  }

  insert<TableName extends string & keyof TablesAndKeys>(
    table: TableName,
    row: RowValue,
  ): Pgoutput.MessageInsert {
    return {tag: 'insert', relation: this.#relationOrFail(table), new: row};
  }

  update<TableName extends string & keyof TablesAndKeys>(
    table: TableName,
    row: RowValue,
    oldKey?: RowKey,
  ): Pgoutput.MessageUpdate {
    return {
      tag: 'update',
      relation: this.#relationOrFail(table),
      new: row,
      key: oldKey ?? null,
      old: null,
    };
  }

  delete<TableName extends string & keyof TablesAndKeys>(
    table: TableName,
    key: RowKey,
  ): Pgoutput.MessageDelete {
    return {
      tag: 'delete',
      relation: this.#relationOrFail(table),
      key,
      old: null,
    };
  }

  truncate<TableName extends string & keyof TablesAndKeys>(
    table: TableName,
    ...moreTables: TableName[]
  ): Pgoutput.MessageTruncate {
    const tables = [table, ...moreTables];
    return {
      tag: 'truncate',
      relations: tables.map(t => this.#relationOrFail(t)),
      cascade: false,
      restartIdentity: false,
    };
  }

  commit(lsn: string): Pgoutput.MessageCommit {
    return {
      tag: 'commit',
      flags: 0,
      commitLsn: null,
      commitEndLsn: lsn,
      commitTime: 0n,
    };
  }
}
