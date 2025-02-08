import websocket from '@fastify/websocket';
import type {LogLevel} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import Fastify, {type FastifyInstance, type FastifyRequest} from 'fastify';
import {copyFileSync} from 'fs';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import WebSocket from 'ws';
import {assert} from '../../../shared/src/asserts.ts';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {Queue} from '../../../shared/src/queue.ts';
import {randInt} from '../../../shared/src/rand.ts';
import type {AST} from '../../../zero-protocol/src/ast.ts';
import type {ChangeDesiredQueriesMessage} from '../../../zero-protocol/src/change-desired-queries.ts';
import type {InitConnectionMessage} from '../../../zero-protocol/src/connect.ts';
import type {PokeStartMessage} from '../../../zero-protocol/src/poke.ts';
import {PROTOCOL_VERSION} from '../../../zero-protocol/src/protocol-version.ts';
import type {ChangeStreamMessage} from '../services/change-source/protocol/current/downstream.ts';
import {
  changeSourceUpstreamSchema,
  type ChangeSourceUpstream,
} from '../services/change-source/protocol/current/upstream.ts';
import {getConnectionURI, testDBs} from '../test/db.ts';
import {DbFile} from '../test/lite.ts';
import type {PostgresDB} from '../types/pg.ts';
import {childWorker, type Worker} from '../types/processes.ts';
import {stream, type Sink} from '../types/streams.ts';

// Adjust to debug.
const LOG_LEVEL: LogLevel = 'error';

const INITIAL_PG_SETUP = `
      CREATE TABLE foo(
        id TEXT PRIMARY KEY, 
        far_id TEXT,
        b BOOL,
        j1 JSON,
        j2 JSONB,
        j3 JSON,
        j4 JSON
      );
      INSERT INTO foo(id, far_id, b, j1, j2, j3, j4) 
        VALUES (
          'bar',
          'baz',
          true,
          '{"foo":"bar"}',
          'true',
          '123',
          '"string"');

      CREATE SCHEMA boo;
      CREATE TABLE boo.far(id TEXT PRIMARY KEY);
      INSERT INTO boo.far(id) VALUES ('baz');

      CREATE TABLE nopk(id TEXT NOT NULL, val TEXT);
      INSERT INTO nopk(id, val) VALUES ('foo', 'bar');

      CREATE PUBLICATION zero_all FOR TABLE foo, TABLE boo.far, TABLE nopk;
`;

// Keep this in sync with the INITIAL_PG_SETUP
const INITIAL_CUSTOM_SETUP: ChangeStreamMessage[] = [
  ['begin', {tag: 'begin'}, {commitWatermark: '101'}],
  [
    'data',
    {
      tag: 'create-table',
      spec: {
        schema: 'public',
        name: 'foo',
        columns: {
          id: {pos: 0, dataType: 'text', notNull: true},
          ['far_id']: {pos: 1, dataType: 'text'},
          b: {pos: 2, dataType: 'bool'},
          j1: {pos: 3, dataType: 'json'},
          j2: {pos: 4, dataType: 'jsonb'},
          j3: {pos: 5, dataType: 'json'},
          j4: {pos: 6, dataType: 'json'},
        },
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-index',
      spec: {
        name: 'foo_key',
        schema: 'public',
        tableName: 'foo',
        columns: {id: 'ASC'},
        unique: true,
      },
    },
  ],
  [
    'data',
    {
      tag: 'insert',
      relation: {
        schema: 'public',
        name: 'foo',
        keyColumns: ['id'],
      },
      new: {
        id: 'bar',
        ['far_id']: 'baz',
        b: true,
        j1: {foo: 'bar'},
        j2: true,
        j3: 123,
        j4: 'string',
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-table',
      spec: {
        schema: 'boo',
        name: 'far',
        columns: {
          id: {pos: 0, dataType: 'text', notNull: true},
        },
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-index',
      spec: {
        name: 'boo_far_key',
        schema: 'boo',
        tableName: 'far',
        columns: {id: 'ASC'},
        unique: true,
      },
    },
  ],
  [
    'data',
    {
      tag: 'insert',
      relation: {
        schema: 'boo',
        name: 'far',
        keyColumns: ['id'],
      },
      new: {
        id: 'baz',
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-table',
      spec: {
        schema: 'public',
        name: 'nopk',
        columns: {
          id: {pos: 0, dataType: 'text', notNull: true},
          val: {pos: 1, dataType: 'text'},
        },
      },
    },
  ],
  [
    'data',
    {
      tag: 'insert',
      relation: {
        schema: 'public',
        name: 'nopk',
        keyColumns: [],
      },
      new: {
        id: 'foo',
        val: 'bar',
      },
    },
  ],
  // Required internal tables
  [
    'data',
    {
      tag: 'create-table',
      spec: {
        schema: 'zero_0',
        name: 'clients',
        primaryKey: ['clientGroupID', 'clientID'],
        columns: {
          clientGroupID: {pos: 0, dataType: 'text', notNull: true},
          clientID: {pos: 1, dataType: 'text', notNull: true},
          lastMutationID: {pos: 2, dataType: 'bigint'},
          userID: {pos: 3, dataType: 'text'},
        },
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-index',
      spec: {
        name: 'zero_clients_key',
        schema: 'zero_0',
        tableName: 'clients',
        columns: {
          clientGroupID: 'ASC',
          clientID: 'ASC',
        },
        unique: true,
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-table',
      spec: {
        schema: 'zero',
        name: 'schemaVersions',
        primaryKey: ['lock'],
        columns: {
          lock: {pos: 0, dataType: 'bool', notNull: true},
          minSupportedVersion: {pos: 1, dataType: 'int'},
          maxSupportedVersion: {pos: 2, dataType: 'int'},
        },
      },
    },
  ],
  [
    'data',
    {
      tag: 'create-index',
      spec: {
        name: 'zero_schemaVersions_key',
        schema: 'zero',
        tableName: 'schemaVersions',
        columns: {lock: 'ASC'},
        unique: true,
      },
    },
  ],
  [
    'data',
    {
      tag: 'insert',
      relation: {
        schema: 'zero',
        name: 'schemaVersions',
        keyColumns: ['lock'],
      },
      new: {lock: true, minSupportedVersion: 1, maxSupportedVersion: 1},
    },
  ],
  ['commit', {tag: 'commit'}, {watermark: '101'}],
];

describe('integration', {timeout: 30000}, () => {
  let upDB: PostgresDB;
  let cvrDB: PostgresDB;
  let changeDB: PostgresDB;
  let replicaDbFile: DbFile;
  let replicaDbFile2: DbFile;
  let env: Record<string, string>;
  let port: number;
  let port2: number;
  let zeros: Worker[];
  let zerosExited: Promise<number>[];
  let customBackend: FastifyInstance;
  let customChangeSourceURI: string;
  let customDownstream: Promise<Sink<ChangeStreamMessage>>;

  const SCHEMA = {
    permissions: {},
    schema: {
      version: 1,
      tables: {},
      relationships: {},
    },
  } as const;

  const mockExit = vi
    .spyOn(process, 'exit')
    .mockImplementation(() => void 0 as never);

  afterAll(() => {
    mockExit.mockRestore();
  });

  const CHANGE_SOURCE_PATH = '/foo/changes/v0/stream';

  beforeEach(async () => {
    upDB = await testDBs.create('integration_test_upstream');
    cvrDB = await testDBs.create('integration_test_cvr');
    changeDB = await testDBs.create('integration_test_change');
    replicaDbFile = new DbFile('integration_test_replica');
    replicaDbFile2 = new DbFile('integration_test_replica2');
    zeros = [];
    zerosExited = [];

    customBackend = Fastify();
    await customBackend.register(websocket);

    const {promise, resolve} = resolver<Sink<ChangeStreamMessage>>();
    customDownstream = promise;
    customBackend.get(
      CHANGE_SOURCE_PATH,
      {websocket: true},
      (ws: WebSocket, req: FastifyRequest) => {
        const {outstream} = stream<ChangeSourceUpstream, ChangeStreamMessage>(
          createSilentLogContext(),
          ws,
          changeSourceUpstreamSchema,
        );
        if (req.url.includes('lastWatermark=')) {
          resolve(outstream);
        } else {
          // Initial sync.
          for (const change of INITIAL_CUSTOM_SETUP) {
            outstream.push(change);
          }
        }
      },
    );
    customChangeSourceURI =
      (await customBackend.listen({port: 0})) + CHANGE_SOURCE_PATH;

    await upDB.unsafe(INITIAL_PG_SETUP);

    port = randInt(5000, 16000);
    port2 = randInt(5000, 16000);

    process.env['SINGLE_PROCESS'] = '1';

    env = {
      ['ZERO_PORT']: String(port),
      ['ZERO_LOG_LEVEL']: LOG_LEVEL,
      ['ZERO_UPSTREAM_DB']: getConnectionURI(upDB),
      ['ZERO_UPSTREAM_MAX_CONNS']: '3',
      ['ZERO_CVR_DB']: getConnectionURI(cvrDB),
      ['ZERO_CVR_MAX_CONNS']: '3',
      ['ZERO_SHARD_PUBLICATIONS']: 'zero_all',
      ['ZERO_CHANGE_DB']: getConnectionURI(changeDB),
      ['ZERO_REPLICA_FILE']: replicaDbFile.path,
      ['ZERO_SCHEMA_JSON']: JSON.stringify(SCHEMA),
      ['ZERO_NUM_SYNC_WORKERS']: '1',
    };
  }, 30000);

  const FOO_QUERY: AST = {
    table: 'foo',
    orderBy: [['id', 'asc']],
    related: [
      {
        correlation: {
          parentField: ['far_id'],
          childField: ['id'],
        },
        subquery: {
          table: 'boo.far',
          orderBy: [['id', 'asc']],
          alias: 'far',
        },
      },
    ],
  };

  const NOPK_QUERY: AST = {
    table: 'nopk',
    orderBy: [['id', 'asc']],
  };

  // One or two zero-caches (i.e. multi-node)
  type Envs = [NodeJS.ProcessEnv] | [NodeJS.ProcessEnv, NodeJS.ProcessEnv];

  async function startZero(envs: Envs) {
    assert(zeros.length === 0);
    assert(zerosExited.length === 0);

    let i = 0;
    for (const env of envs) {
      if (++i === 2) {
        // For multi-node, copy the initially-synced replica file from the
        // replication-manager to the replica file for the view-syncer.
        copyFileSync(replicaDbFile.path, replicaDbFile2.path);
      }
      const {promise: ready, resolve: onReady} = resolver<unknown>();
      const {promise: done, resolve: onClose} = resolver<number>();

      zerosExited.push(done);

      const zero = childWorker('./server/multi/main.ts', env);
      zero.onMessageType('ready', onReady);
      zero.on('close', onClose);
      zeros.push(zero);
      await ready;
    }
  }

  afterEach(async () => {
    try {
      zeros.forEach(zero => zero.kill('SIGTERM')); // initiate and await graceful shutdown
      (await Promise.all(zerosExited)).forEach(code => expect(code).toBe(0));
    } finally {
      await testDBs.drop(upDB, cvrDB, changeDB);
      replicaDbFile.delete();
      replicaDbFile2.delete();
    }
  }, 30000);

  async function streamCustomChanges(changes: ChangeStreamMessage[]) {
    const sink = await customDownstream;
    for (const change of changes) {
      sink.push(change);
    }
  }

  const WATERMARK_REGEX = /[0-9a-z]{4,}/;

  test.each([
    ['single-node standalone', 'pg', () => [env]],
    [
      'single-node multi-tenant direct-dispatch',
      'pg',
      () => [
        {
          ['ZERO_PORT']: String(port - 3),
          ['ZERO_LOG_LEVEL']: LOG_LEVEL,
          ['ZERO_TENANTS_JSON']: JSON.stringify({
            tenants: [{id: 'tenant', path: '/zero', env}],
          }),
        },
      ],
    ],
    [
      'single-node multi-tenant, double-dispatch',
      'pg',
      () => [
        {
          ['ZERO_PORT']: String(port),
          ['ZERO_LOG_LEVEL']: LOG_LEVEL,
          ['ZERO_TENANTS_JSON']: JSON.stringify({
            tenants: [
              {
                id: 'tenant',
                path: '/zero',
                env: {...env, ['ZERO_PORT']: String(port + 3)},
              },
            ],
          }),
        },
      ],
    ],
    [
      'multi-node standalone',
      'pg',
      () => [
        // The replication-manager must be started first for initial-sync
        {
          ...env,
          ['ZERO_PORT']: `${port2}`,
          ['ZERO_NUM_SYNC_WORKERS']: '0',
        },
        // startZero() will then copy to replicaDbFile2 for the view-syncer
        {
          ...env,
          ['ZERO_CHANGE_STREAMER_URI']: `http://localhost:${port2 + 1}`,
          ['ZERO_REPLICA_FILE']: replicaDbFile2.path,
        },
      ],
    ],
    [
      'multi-node multi-tenant',
      'pg',
      () => [
        // The replication-manager must be started first for initial-sync
        {
          ['ZERO_PORT']: String(port2),
          ['ZERO_LOG_LEVEL']: LOG_LEVEL,
          ['ZERO_NUM_SYNC_WORKERS']: '0',
          ['ZERO_TENANTS_JSON']: JSON.stringify({
            tenants: [
              {
                id: 'tenant',
                path: '/zero',
                env: {
                  ...env,
                  ['ZERO_PORT']: String(port2 + 3),
                  ['ZERO_NUM_SYNC_WORKERS']: '0',
                },
              },
            ],
          }),
        },
        // startZero() will then copy to replicaDbFile2 for the view-syncer
        {
          ['ZERO_PORT']: String(port),
          ['ZERO_LOG_LEVEL']: LOG_LEVEL,
          ['ZERO_CHANGE_STREAMER_URI']: `http://localhost:${port2 + 1}`,
          ['ZERO_REPLICA_FILE']: replicaDbFile2.path,
          ['ZERO_TENANTS_JSON']: JSON.stringify({
            tenants: [
              {
                id: 'tenant',
                path: '/zero',
                env: {...env, ['ZERO_PORT']: String(port + 3)},
              },
            ],
          }),
        },
      ],
    ],
    [
      'single-node standalone',
      'custom',
      () => [
        {
          ...env,
          ['ZERO_UPSTREAM_DB']: customChangeSourceURI,
          ['ZERO_UPSTREAM_TYPE']: 'custom',
        },
      ],
    ],
  ] satisfies [string, 'pg' | 'custom', () => Envs][])(
    '%s (%s)',
    async (_name, backend, makeEnvs) => {
      await startZero(makeEnvs());

      const downstream = new Queue<unknown>();
      const ws = new WebSocket(
        `ws://localhost:${port}/zero/sync/v${PROTOCOL_VERSION}/connect` +
          `?clientGroupID=abc&clientID=def&wsid=123&schemaVersion=1&baseCookie=&ts=123456789&lmid=1`,
        encodeURIComponent(btoa('{}')), // auth token
      );
      ws.on('message', data =>
        downstream.enqueue(JSON.parse(data.toString('utf-8'))),
      );
      ws.on('open', () =>
        ws.send(
          JSON.stringify([
            'initConnection',
            {
              desiredQueriesPatch: [
                {op: 'put', hash: 'query-hash1', ast: FOO_QUERY},
              ],
            },
          ] satisfies InitConnectionMessage),
        ),
      );

      expect(await downstream.dequeue()).toMatchObject([
        'connected',
        {wsid: '123'},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: '00'},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: '00'},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: '00:01'},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: '00:01',
          clientsPatch: [{op: 'put', clientID: 'def'}],
          desiredQueriesPatches: {
            def: [{op: 'put', hash: 'query-hash1', ast: FOO_QUERY}],
          },
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: '00:01'},
      ]);
      const contentPokeStart = (await downstream.dequeue()) as PokeStartMessage;
      expect(contentPokeStart).toMatchObject([
        'pokeStart',
        {pokeID: /[0-9a-z]{2,}/},
      ]);
      const contentPokeID = contentPokeStart[1].pokeID;
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: contentPokeID,
          gotQueriesPatch: [{op: 'put', hash: 'query-hash1', ast: FOO_QUERY}],
          rowsPatch: [
            {
              op: 'put',
              tableName: 'foo',
              value: {
                id: 'bar',
                ['far_id']: 'baz',
                b: true,
                j1: {foo: 'bar'},
                j2: true,
                j3: 123,
                j4: 'string',
              },
            },
            {
              op: 'put',
              tableName: 'boo.far',
              value: {
                id: 'baz',
              },
            },
          ],
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: contentPokeID},
      ]);

      // Trigger an upstream change and verify replication.
      if (backend === 'pg') {
        await upDB`
          INSERT INTO foo(id, far_id, b, j1, j2, j3, j4) 
            VALUES ('voo', 'doo', false, '"foo"', 'false', '456.789', '{"bar":"baz"}');
          UPDATE foo SET far_id = 'not_baz' WHERE id = 'bar';
        `.simple();
      } else {
        await streamCustomChanges([
          ['begin', {tag: 'begin'}, {commitWatermark: '102'}],
          [
            'data',
            {
              tag: 'insert',
              relation: {
                schema: 'public',
                name: 'foo',
                keyColumns: ['id'],
              },
              new: {
                id: 'voo',
                ['far_id']: 'doo',
                b: false,
                j1: 'foo',
                j2: false,
                j3: 456.789,
                j4: {bar: 'baz'},
              },
            },
          ],
          [
            'data',
            {
              tag: 'update',
              relation: {
                schema: 'public',
                name: 'foo',
                keyColumns: ['id'],
              },
              new: {
                id: 'bar',
                ['far_id']: 'not_baz',
              },
              key: null,
              old: null,
            },
          ],
          ['commit', {tag: 'commit'}, {watermark: '102'}],
        ]);
      }

      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: WATERMARK_REGEX},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: WATERMARK_REGEX,
          rowsPatch: [
            {
              op: 'put',
              tableName: 'foo',
              value: {
                b: true,
                ['far_id']: 'not_baz',
                id: 'bar',
                j1: {
                  foo: 'bar',
                },
                j2: true,
                j3: 123,
                j4: 'string',
              },
            },
            // boo.far {id: 'baz'} is no longer referenced by foo {id: 'bar}
            {
              id: {id: 'baz'},
              op: 'del',
              tableName: 'boo.far',
            },
            {
              op: 'put',
              tableName: 'foo',
              value: {
                id: 'voo',
                ['far_id']: 'doo',
                b: false,
                j1: 'foo',
                j2: false,
                j3: 456.789,
                j4: {bar: 'baz'},
              },
            },
          ],
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: WATERMARK_REGEX},
      ]);

      // Test TRUNCATE
      if (backend === 'pg') {
        await upDB`TRUNCATE TABLE foo RESTART IDENTITY`;
      } else {
        await streamCustomChanges([
          ['begin', {tag: 'begin'}, {commitWatermark: '103'}],
          [
            'data',
            {
              tag: 'truncate',
              relations: [
                {
                  schema: 'public',
                  name: 'foo',
                  keyColumns: ['id'],
                },
              ],
            },
          ],
          ['commit', {tag: 'commit'}, {watermark: '103'}],
        ]);
      }

      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: WATERMARK_REGEX},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: WATERMARK_REGEX,
          rowsPatch: [
            {
              op: 'del',
              tableName: 'foo',
              id: {id: 'bar'},
            },
            {
              op: 'del',
              tableName: 'foo',
              id: {id: 'voo'},
            },
          ],
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: WATERMARK_REGEX},
      ]);

      // Test that INSERTs into tables without primary keys are replicated.
      if (backend === 'pg') {
        await upDB.unsafe(`
      INSERT INTO nopk(id, val) VALUES ('bar', 'baz');
      CREATE UNIQUE INDEX nopk_key ON nopk (id);
    `);
      } else {
        await streamCustomChanges([
          ['begin', {tag: 'begin'}, {commitWatermark: '104'}],
          [
            'data',
            {
              tag: 'insert',
              relation: {
                schema: 'public',
                name: 'nopk',
                keyColumns: [],
              },
              new: {
                id: 'bar',
                val: 'baz',
              },
            },
          ],
          [
            'data',
            {
              tag: 'create-index',
              spec: {
                name: 'nopk_now_has_key_yay',
                schema: 'public',
                tableName: 'nopk',
                columns: {id: 'ASC'},
                unique: true,
              },
            },
          ],
          ['commit', {tag: 'commit'}, {watermark: '104'}],
        ]);
      }

      // A rare case of a no-op poke happens when the advancement resets the
      // pipelines, bumping the CVR to the current state version. This conveniently
      // allows the integration test to correctly wait for the schema change to
      // take effect.
      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: WATERMARK_REGEX},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: WATERMARK_REGEX},
      ]);

      // Now that nopk has a unique index, add a query to retrieve the data.
      ws.send(
        JSON.stringify([
          'changeDesiredQueries',
          {
            desiredQueriesPatch: [
              {op: 'put', hash: 'query-hash2', ast: NOPK_QUERY},
            ],
          },
        ] satisfies ChangeDesiredQueriesMessage),
      );

      // poke confirming the query registration.
      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: WATERMARK_REGEX},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: WATERMARK_REGEX,
          desiredQueriesPatches: {
            def: [{op: 'put', hash: 'query-hash2', ast: NOPK_QUERY}],
          },
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: WATERMARK_REGEX},
      ]);

      // poke containing the row data.
      expect(await downstream.dequeue()).toMatchObject([
        'pokeStart',
        {pokeID: WATERMARK_REGEX},
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokePart',
        {
          pokeID: WATERMARK_REGEX,
          rowsPatch: [
            {
              op: 'put',
              tableName: 'nopk',
              value: {id: 'bar', val: 'baz'},
            },
            {
              op: 'put',
              tableName: 'nopk',
              value: {id: 'foo', val: 'bar'},
            },
          ],
        },
      ]);
      expect(await downstream.dequeue()).toMatchObject([
        'pokeEnd',
        {pokeID: WATERMARK_REGEX},
      ]);
    },
  );
});
