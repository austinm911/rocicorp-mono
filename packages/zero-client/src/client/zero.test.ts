import {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import * as sinon from 'sinon';
import {afterEach, beforeEach, expect, suite, test} from 'vitest';
import {setDeletedClients} from '../../../replicache/src/deleted-clients.ts';
import type {ReplicacheImpl} from '../../../replicache/src/replicache-impl.ts';
import type {PullRequest} from '../../../replicache/src/sync/pull.ts';
import type {PushRequest} from '../../../replicache/src/sync/push.ts';
import {withWrite} from '../../../replicache/src/with-transactions.ts';
import {assert} from '../../../shared/src/asserts.ts';
import {TestLogSink} from '../../../shared/src/logging-test-utils.ts';
import * as valita from '../../../shared/src/valita.ts';
import type {AST} from '../../../zero-protocol/src/ast.ts';
import {changeDesiredQueriesMessageSchema} from '../../../zero-protocol/src/change-desired-queries.ts';
import {
  decodeSecProtocols,
  encodeSecProtocols,
  initConnectionMessageSchema,
} from '../../../zero-protocol/src/connect.ts';
import * as ErrorKind from '../../../zero-protocol/src/error-kind-enum.ts';
import * as MutationType from '../../../zero-protocol/src/mutation-type-enum.ts';
import {PROTOCOL_VERSION} from '../../../zero-protocol/src/protocol-version.ts';
import {
  type CRUDOp,
  type Mutation,
  pushMessageSchema,
} from '../../../zero-protocol/src/push.ts';
import type {NullableVersion} from '../../../zero-protocol/src/version.ts';
import {
  createSchema,
  type Schema,
} from '../../../zero-schema/src/builder/schema-builder.ts';
import {
  number,
  string,
  table,
} from '../../../zero-schema/src/builder/table-builder.ts';
import * as ConnectionState from './connection-state-enum.ts';
import type {CustomMutatorDefs} from './custom.ts';
import type {DeleteClientsManager} from './delete-clients-manager.ts';
import type {WSString} from './http-string.ts';
import type {UpdateNeededReason, ZeroOptions} from './options.ts';
import type {QueryManager} from './query-manager.ts';
import {RELOAD_REASON_STORAGE_KEY} from './reload-error-handler.ts';
import {ServerError} from './server-error.ts';
import {
  MockSocket,
  storageMock,
  TestZero,
  tickAFewTimes,
  waitForUpstreamMessage,
  zeroForTest,
} from './test-utils.ts'; // Why use fakes when we can use the real thing!
import {
  CONNECT_TIMEOUT_MS,
  createSocket,
  DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  PULL_TIMEOUT_MS,
  RUN_LOOP_INTERVAL_MS,
} from './zero.ts';

let clock: sinon.SinonFakeTimers;
const startTime = 1678829450000;

let fetchStub: sinon.SinonStub<
  Parameters<typeof fetch>,
  ReturnType<typeof fetch>
>;

beforeEach(() => {
  clock = sinon.useFakeTimers();
  clock.setSystemTime(startTime);
  sinon.replace(
    globalThis,
    'WebSocket',
    MockSocket as unknown as typeof WebSocket,
  );
  fetchStub = sinon
    .stub(globalThis, 'fetch')
    .returns(Promise.resolve(new Response()));
});

afterEach(() => {
  sinon.restore();
});

test('onOnlineChange callback', async () => {
  let onlineCount = 0;
  let offlineCount = 0;

  const z = zeroForTest({
    logLevel: 'debug',
    schema: createSchema(1, {
      tables: [
        table('foo')
          .columns({
            id: string(),
            val: string(),
          })
          .primaryKey('id'),
      ],
    }),
    onOnlineChange: online => {
      if (online) {
        onlineCount++;
      } else {
        offlineCount++;
      }
    },
  });

  {
    // Offline by default.
    await clock.tickAsync(1);
    expect(z.online).false;
  }

  {
    // First test a disconnect followed by a reconnect. This should not trigger
    // the onOnlineChange callback.
    await z.waitForConnectionState(ConnectionState.Connecting);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(0);
    await z.triggerConnected();
    await z.waitForConnectionState(ConnectionState.Connected);
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(0);
    await z.triggerClose();
    await z.waitForConnectionState(ConnectionState.Disconnected);
    // Still connected because we haven't yet failed to reconnect.
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(0);
    await z.triggerConnected();
    await z.waitForConnectionState(ConnectionState.Connected);
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(0);
  }

  {
    // Now testing with an error that causes the connection to close. This should
    // trigger the callback.
    onlineCount = offlineCount = 0;
    await z.triggerError(ErrorKind.InvalidMessage, 'aaa');
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await clock.tickAsync(0);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(1);

    // And followed by a reconnect.
    expect(z.online).false;
    await tickAFewTimes(clock, RUN_LOOP_INTERVAL_MS);
    await z.triggerConnected();
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(1);
  }

  {
    // Now testing with ServerOverloaded error with a large backoff.
    const BACKOFF_MS = RUN_LOOP_INTERVAL_MS * 10;
    onlineCount = offlineCount = 0;
    await z.triggerError(ErrorKind.ServerOverloaded, 'slow down', {
      minBackoffMs: BACKOFF_MS,
    });
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await clock.tickAsync(0);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(1);

    // And followed by a reconnect with the longer BACKOFF_MS.
    expect(z.online).false;
    await tickAFewTimes(clock, BACKOFF_MS);
    await z.triggerConnected();
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(1);
  }

  {
    // Now test a short backoff directive.
    const BACKOFF_MS = 10;
    onlineCount = offlineCount = 0;
    await z.triggerError(ErrorKind.Rehome, 'rehomed', {
      maxBackoffMs: BACKOFF_MS,
      reconnectParams: {
        reason: 'rehomed',
        fromServer: 'foo/bar/baz',
      },
    });
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await clock.tickAsync(0);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(1);

    // And followed by a reconnect with the longer BACKOFF_MS.
    expect(z.online).false;
    await tickAFewTimes(clock, BACKOFF_MS);
    await z.triggerConnected();
    const connectMsg = z.testLogSink.messages.findLast(
      ([level, _context, args]) =>
        level === 'info' && args.find(arg => /Connecting to/.test(String(arg))),
    );
    expect(connectMsg?.[2][1]).matches(
      /&reason=rehomed&fromServer=foo%2Fbar%2Fbaz/,
    );
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(1);
  }

  {
    // Now test with an auth error. This should not trigger the callback on the first error.
    onlineCount = offlineCount = 0;
    await z.triggerError(ErrorKind.Unauthorized, 'bbb');
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(0);

    // And followed by a reconnect.
    expect(z.online).true;
    await z.triggerConnected();
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(0);
  }

  {
    // Now test with two auth error. This should trigger the callback on the second error.
    onlineCount = offlineCount = 0;
    await z.triggerError(ErrorKind.Unauthorized, 'ccc');
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(0);

    await z.waitForConnectionState(ConnectionState.Connecting);
    await z.triggerError(ErrorKind.Unauthorized, 'ddd');
    await z.waitForConnectionState(ConnectionState.Disconnected);
    await tickAFewTimes(clock, RUN_LOOP_INTERVAL_MS);
    await clock.tickAsync(0);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(1);

    // And followed by a reconnect.
    await z.waitForConnectionState(ConnectionState.Connecting);
    await z.triggerConnected();
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(1);
  }

  {
    // Connection timed out.
    onlineCount = offlineCount = 0;
    await clock.tickAsync(CONNECT_TIMEOUT_MS);
    expect(z.online).false;
    expect(onlineCount).to.equal(0);
    expect(offlineCount).to.equal(1);
    await clock.tickAsync(RUN_LOOP_INTERVAL_MS);
    // and back online
    await z.triggerConnected();
    await clock.tickAsync(0);
    expect(z.online).true;
    expect(onlineCount).to.equal(1);
    expect(offlineCount).to.equal(1);
  }
});

test('disconnects if ping fails', async () => {
  const watchdogInterval = RUN_LOOP_INTERVAL_MS;
  const pingTimeout = 5000;
  const r = zeroForTest();

  await r.waitForConnectionState(ConnectionState.Connecting);
  expect(r.connectionState).to.equal(ConnectionState.Connecting);

  await r.triggerConnected();
  await r.waitForConnectionState(ConnectionState.Connected);
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  (await r.socket).messages.length = 0;

  // Wait PING_INTERVAL_MS which will trigger a ping
  // Pings timeout after PING_TIMEOUT_MS so reply before that.
  await tickAFewTimes(clock, PING_INTERVAL_MS);
  expect((await r.socket).messages).to.deep.equal(['["ping",{}]']);

  await r.triggerPong();
  await tickAFewTimes(clock);
  expect(r.connectionState).to.equal(ConnectionState.Connected);

  await tickAFewTimes(clock, watchdogInterval);
  await r.triggerPong();
  await tickAFewTimes(clock);
  expect(r.connectionState).to.equal(ConnectionState.Connected);

  await tickAFewTimes(clock, watchdogInterval);
  expect(r.connectionState).to.equal(ConnectionState.Connected);

  await tickAFewTimes(clock, pingTimeout);
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
});

const mockRep = {
  query() {
    return Promise.resolve(new Map());
  },
} as unknown as ReplicacheImpl;
const mockQueryManager = {
  getQueriesPatch() {
    return Promise.resolve([]);
  },
} as unknown as QueryManager;

const mockDeleteClientsManager = {
  getDeletedClients: () => Promise.resolve(['old-deleted-client']),
} as unknown as DeleteClientsManager;

suite('createSocket', () => {
  const t = (
    socketURL: WSString,
    baseCookie: NullableVersion,
    clientID: string,
    userID: string,
    auth: string | undefined,
    lmid: number,
    debugPerf: boolean,
    now: number,
    expectedURL: string,
    additionalConnectParams?: Record<string, string>,
  ) => {
    const schemaVersion = 3;
    test(expectedURL, async () => {
      sinon.stub(performance, 'now').returns(now);
      const [mockSocket, queriesPatch, deletedClients] = await createSocket(
        mockRep,
        mockQueryManager,
        mockDeleteClientsManager,
        socketURL,
        baseCookie,
        clientID,
        'testClientGroupID',
        schemaVersion,
        userID,
        auth,
        lmid,
        'wsidx',
        debugPerf,
        new LogContext('error', undefined, new TestLogSink()),
        1048 * 8,
        additionalConnectParams,
      );
      expect(`${mockSocket.url}`).equal(expectedURL);
      expect(mockSocket.protocol).equal(
        encodeSecProtocols(
          [
            'initConnection',
            {desiredQueriesPatch: [], deletedClients: ['old-deleted-client']},
          ],
          auth,
        ),
      );
      expect(queriesPatch).toEqual(new Map());
      expect(deletedClients).toBeUndefined();

      const [mockSocket2, queriesPatch2, deletedClients2] = await createSocket(
        mockRep,
        mockQueryManager,
        mockDeleteClientsManager,
        socketURL,
        baseCookie,
        clientID,
        'testClientGroupID',
        schemaVersion,
        userID,
        auth,
        lmid,
        'wsidx',
        debugPerf,
        new LogContext('error', undefined, new TestLogSink()),
        0, // do not put any extra information into headers
        additionalConnectParams,
      );
      expect(`${mockSocket.url}`).equal(expectedURL);
      expect(mockSocket2.protocol).equal(encodeSecProtocols(undefined, auth));
      // if we did not encode queries into the sec-protocol header, we should not have a queriesPatch
      expect(queriesPatch2).toBeUndefined();
      expect(deletedClients2).toEqual(['old-deleted-client']);
    });
  };

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    '',
    0,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx`,
  );
  t(
    'ws://example.com/prefix',
    null,
    'clientID',
    'userID',
    '',
    0,
    false,
    0,
    `ws://example.com/prefix/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx`,
  );
  t(
    'ws://example.com/prefix/',
    null,
    'clientID',
    'userID',
    '',
    0,
    false,
    0,
    `ws://example.com/prefix/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    '1234',
    'clientID',
    'userID',
    '',
    0,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=1234&ts=0&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    '1234',
    'clientID',
    'userID',
    '',
    0,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=1234&ts=0&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    '',
    123,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=123&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    undefined,
    123,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=123&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    'auth with []',
    0,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    'auth with []',
    0,
    false,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    'auth with []',
    0,
    true,
    0,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=0&lmid=0&wsid=wsidx&debugPerf=true`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    '',
    0,
    false,
    456,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=456&lmid=0&wsid=wsidx`,
  );

  t(
    'ws://example.com/',
    null,
    'clientID',
    'userID',
    '',
    0,
    false,
    456,
    `ws://example.com/sync/v${PROTOCOL_VERSION}/connect?clientID=clientID&clientGroupID=testClientGroupID&schemaVersion=3&userID=userID&baseCookie=&ts=456&lmid=0&wsid=wsidx&reason=rehome&backoff=100&lastTask=foo%2Fbar%26baz`,
    {
      reason: 'rehome',
      backoff: '100',
      lastTask: 'foo/bar&baz',
      clientID: 'conflicting-parameter-ignored',
    },
  );
});

suite('initConnection', () => {
  test('not sent when connected message received but before ConnectionState.Connected', async () => {
    const r = zeroForTest();
    const mockSocket = await r.socket;

    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    // upon receiving `connected` we do not sent `initConnection` since it is sent
    // when opening the connection.
    expect(mockSocket.messages.length).toEqual(0);
  });

  test('sent when connected message received but before ConnectionState.Connected desired queries > maxHeaderLength', async () => {
    const r = zeroForTest({
      maxHeaderLength: 0,
    });
    const mockSocket = await r.socket;
    mockSocket.onUpstream = msg => {
      expect(
        valita.parse(JSON.parse(msg), initConnectionMessageSchema),
      ).toEqual([
        'initConnection',
        {
          desiredQueriesPatch: [],
        },
      ]);
      expect(r.connectionState).toEqual(ConnectionState.Connecting);
    };

    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(1);
  });

  test('sent when connected message received but before ConnectionState.Connected desired queries > maxHeaderLength, with deletedClients', async () => {
    const r = await zeroForTestWithDeletedClients({
      maxHeaderLength: 0,
      deletedClients: ['a'],
    });

    const mockSocket = await r.socket;
    mockSocket.onUpstream = msg => {
      expect(valita.parse(JSON.parse(msg), initConnectionMessageSchema))
        .toMatchInlineSnapshot(`
        [
          "initConnection",
          {
            "deletedClients": [
              "a",
            ],
            "desiredQueriesPatch": [],
          },
        ]
      `);
      expect(r.connectionState).toEqual(ConnectionState.Connecting);
    };

    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(1);
  });

  test('sends desired queries patch in sec-protocol header', async () => {
    const r = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    const view = r.query.e.materialize();
    view.addListener(() => {});

    const mockSocket = await r.socket;

    expect(
      valita.parse(
        decodeSecProtocols(mockSocket.protocol).initConnectionMessage,
        initConnectionMessageSchema,
      ),
    ).toMatchInlineSnapshot(`
      [
        "initConnection",
        {
          "desiredQueriesPatch": [
            {
              "ast": {
                "orderBy": [
                  [
                    "id",
                    "asc",
                  ],
                ],
                "table": "e",
              },
              "hash": "29j3x0l4bxthp",
              "op": "put",
            },
          ],
        },
      ]
    `);

    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(0);
  });

  async function zeroForTestWithDeletedClients<
    const S extends Schema,
    MD extends CustomMutatorDefs<S> = CustomMutatorDefs<S>,
  >(
    options: Partial<ZeroOptions<S, MD>> & {deletedClients: string[]},
  ): Promise<TestZero<S, MD>> {
    // We need to set the deleted clients before creating the zero instance but
    // we use a random name for the user ID. So we create a zero instance with a
    // random user ID, set the deleted clients, close it and then create a new
    // zero instance with the same user ID.
    const r0 = zeroForTest(options);
    await withWrite(r0.perdag, dagWrite =>
      setDeletedClients(dagWrite, options.deletedClients),
    );
    await r0.close();

    return zeroForTest({
      ...options,
      userID: r0.userID,
    });
  }

  test('sends desired queries patch in sec-protocol header with deletedClients', async () => {
    const r = await zeroForTestWithDeletedClients({
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
      deletedClients: ['a'],
    });

    const view = r.query.e.materialize();
    view.addListener(() => {});

    const mockSocket = await r.socket;

    expect(
      valita.parse(
        decodeSecProtocols(mockSocket.protocol).initConnectionMessage,
        initConnectionMessageSchema,
      ),
    ).toMatchInlineSnapshot(`
      [
        "initConnection",
        {
          "deletedClients": [
            "a",
          ],
          "desiredQueriesPatch": [
            {
              "ast": {
                "orderBy": [
                  [
                    "id",
                    "asc",
                  ],
                ],
                "table": "e",
              },
              "hash": "29j3x0l4bxthp",
              "op": "put",
            },
          ],
        },
      ]
    `);

    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(0);
  });

  test('sends desired queries patch in `initConnectionMessage` when the patch is over maxHeaderLength', async () => {
    const r = zeroForTest({
      maxHeaderLength: 0,
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });
    const mockSocket = await r.socket;

    mockSocket.onUpstream = msg => {
      expect(valita.parse(JSON.parse(msg), initConnectionMessageSchema))
        .toMatchInlineSnapshot(`
        [
          "initConnection",
          {
            "desiredQueriesPatch": [
              {
                "ast": {
                  "orderBy": [
                    [
                      "id",
                      "asc",
                    ],
                  ],
                  "table": "e",
                },
                "hash": "29j3x0l4bxthp",
                "op": "put",
              },
            ],
          },
        ]
      `);

      expect(r.connectionState).toEqual(ConnectionState.Connecting);
    };

    expect(mockSocket.messages.length).toEqual(0);
    const view = r.query.e.materialize();
    view.addListener(() => {});
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(1);
  });

  test('sends desired queries patch in `initConnectionMessage` when the patch is over maxHeaderLength with deleted clients', async () => {
    const r = await zeroForTestWithDeletedClients({
      maxHeaderLength: 0,
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
      deletedClients: ['a'],
    });
    const mockSocket = await r.socket;

    mockSocket.onUpstream = msg => {
      expect(valita.parse(JSON.parse(msg), initConnectionMessageSchema))
        .toMatchInlineSnapshot(`
        [
          "initConnection",
          {
            "deletedClients": [
              "a",
            ],
            "desiredQueriesPatch": [
              {
                "ast": {
                  "orderBy": [
                    [
                      "id",
                      "asc",
                    ],
                  ],
                  "table": "e",
                },
                "hash": "29j3x0l4bxthp",
                "op": "put",
              },
            ],
          },
        ]
      `);

      expect(r.connectionState).toEqual(ConnectionState.Connecting);
    };

    expect(mockSocket.messages.length).toEqual(0);
    const view = r.query.e.materialize();
    view.addListener(() => {});
    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(1);
  });

  test('sends changeDesiredQueries if new queries are added after initConnection but before connected', async () => {
    const r = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    const mockSocket = await r.socket;
    mockSocket.onUpstream = msg => {
      expect(
        valita.parse(JSON.parse(msg), changeDesiredQueriesMessageSchema),
      ).toEqual([
        'changeDesiredQueries',
        {
          desiredQueriesPatch: [
            {
              ast: {
                table: 'e',
                orderBy: [['id', 'asc']],
              } satisfies AST,
              hash: '29j3x0l4bxthp',
              op: 'put',
            },
          ],
        },
      ]);
      expect(r.connectionState).toEqual(ConnectionState.Connecting);
    };

    expect(
      valita.parse(
        decodeSecProtocols(mockSocket.protocol).initConnectionMessage,
        initConnectionMessageSchema,
      ),
    ).toEqual([
      'initConnection',
      {
        desiredQueriesPatch: [],
      },
    ]);

    expect(mockSocket.messages.length).toEqual(0);

    const view = r.query.e.materialize();
    view.addListener(() => {});

    await r.triggerConnected();
    expect(mockSocket.messages.length).toEqual(1);
  });

  test('changeDesiredQueries does not include queries sent with initConnection', async () => {
    const r = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    const view1 = r.query.e.materialize();
    view1.addListener(() => {});

    const mockSocket = await r.socket;
    expect(mockSocket.messages.length).toEqual(0);

    const view2 = r.query.e.materialize();
    view2.addListener(() => {});
    await r.triggerConnected();
    // no `changeDesiredQueries` sent since the query was already included in `initConnection`
    expect(mockSocket.messages.length).toEqual(0);
  });

  test('changeDesiredQueries does include removal of a query sent with initConnection if it was removed before `connected`', async () => {
    const r = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    const view1 = r.query.e.materialize();
    const removeListener = view1.addListener(() => {});

    const mockSocket = await r.socket;
    mockSocket.onUpstream = msg => {
      expect(
        valita.parse(JSON.parse(msg), changeDesiredQueriesMessageSchema),
      ).toEqual([
        'changeDesiredQueries',
        {
          desiredQueriesPatch: [
            {
              hash: '29j3x0l4bxthp',
              op: 'del',
            },
          ],
        },
      ]);
    };
    expect(mockSocket.messages.length).toEqual(0);

    removeListener();
    view1.destroy();
    // no `changeDesiredQueries` sent yet since we're not connected
    expect(mockSocket.messages.length).toEqual(0);
    await r.triggerConnected();
    // changedDesiredQueries has been sent.
    expect(mockSocket.messages.length).toEqual(1);
  });
});

test('pusher sends one mutation per push message', async () => {
  const t = async (
    pushes: {
      mutations: Mutation[];
      expectedPushMessages: number;
      clientGroupID?: string;
      requestID?: string;
    }[],
  ) => {
    const r = zeroForTest();
    await r.triggerConnected();

    const mockSocket = await r.socket;

    for (const push of pushes) {
      const {
        mutations,
        expectedPushMessages,
        clientGroupID,
        requestID = 'test-request-id',
      } = push;

      const pushReq: PushRequest = {
        profileID: 'p1',
        clientGroupID: clientGroupID ?? (await r.clientGroupID),
        pushVersion: 1,
        schemaVersion: '1',
        mutations,
      };

      mockSocket.messages.length = 0;

      await r.pusher(pushReq, requestID);

      expect(mockSocket.messages).to.have.lengthOf(expectedPushMessages);
      for (let i = 1; i < mockSocket.messages.length; i++) {
        const raw = mockSocket.messages[i];
        const msg = valita.parse(JSON.parse(raw), pushMessageSchema);
        expect(msg[1].clientGroupID).to.equal(
          clientGroupID ?? (await r.clientGroupID),
        );
        expect(msg[1].schemaVersion).to.equal(1);
        expect(msg[1].mutations).to.have.lengthOf(1);
        expect(msg[1].requestID).to.equal(requestID);
      }
    }
  };

  await t([{mutations: [], expectedPushMessages: 0}]);
  await t([
    {
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 1,
          name: 'mut1',
          args: [{d: 1}],
          timestamp: 1,
        },
      ],
      expectedPushMessages: 1,
    },
  ]);
  await t([
    {
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 1,
          name: 'mut1',
          args: [{d: 1}],
          timestamp: 1,
        },
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 1,
          name: 'mut1',
          args: [{d: 2}],
          timestamp: 2,
        },
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
      ],
      expectedPushMessages: 3,
    },
  ]);

  // if for self client group skips [clientID, id] tuples already seen
  await t([
    {
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 1,
          name: 'mut1',
          args: [{d: 1}],
          timestamp: 1,
        },
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 1,
          name: 'mut1',
          args: [{d: 2}],
          timestamp: 2,
        },
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
      ],
      expectedPushMessages: 3,
    },
    {
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 1,
          name: 'mut1',
          args: [{d: 2}],
          timestamp: 2,
        },
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
      ],
      expectedPushMessages: 1,
    },
  ]);

  // if not for self client group (i.e. mutation recovery) does not skip
  // [clientID, id] tuples already seen
  await t([
    {
      clientGroupID: 'c1',
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 1,
          name: 'mut1',
          args: [{d: 1}],
          timestamp: 1,
        },
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 1,
          name: 'mut1',
          args: [{d: 2}],
          timestamp: 2,
        },
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
      ],
      expectedPushMessages: 3,
    },
    {
      clientGroupID: 'c1',
      mutations: [
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 1,
          name: 'mut1',
          args: [{d: 2}],
          timestamp: 2,
        },
        {
          type: MutationType.Custom,
          clientID: 'c1',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
        {
          type: MutationType.Custom,
          clientID: 'c2',
          id: 2,
          name: 'mut1',
          args: [{d: 3}],
          timestamp: 3,
        },
      ],
      expectedPushMessages: 3,
    },
  ]);
});

test('pusher maps CRUD mutation names', async () => {
  const t = async (
    pushes: {
      client: CRUDOp[];
      server: CRUDOp[];
    }[],
  ) => {
    const r = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('issue')
            .from('issues')
            .columns({
              id: string(),
              title: string().optional(),
            })
            .primaryKey('id'),
          table('comment')
            .from('comments')
            .columns({
              id: string(),
              issueId: string().from('issue_id'),
              text: string().optional(),
            })
            .primaryKey('id'),
          table('compoundPKTest')
            .columns({
              id1: string().from('id_1'),
              id2: string().from('id_2'),
              text: string(),
            })
            .primaryKey('id1', 'id2'),
        ],
      }),
    });

    await r.triggerConnected();

    const mockSocket = await r.socket;

    for (const push of pushes) {
      const {client, server} = push;

      const pushReq: PushRequest = {
        profileID: 'p1',
        clientGroupID: await r.clientGroupID,
        pushVersion: 1,
        schemaVersion: '1',
        mutations: [
          {
            // type: MutationType.CRUD,
            clientID: 'c2',
            id: 2,
            name: '_zero_crud',
            args: {ops: client},
            timestamp: 3,
          },
        ],
      };

      mockSocket.messages.length = 0;

      await r.pusher(pushReq, 'test-request-id');

      expect(mockSocket.messages).to.have.lengthOf(1);
      for (let i = 0; i < mockSocket.messages.length; i++) {
        const raw = mockSocket.messages[i];
        const msg = valita.parse(JSON.parse(raw), pushMessageSchema);
        expect(msg[1].mutations[0].args[0]).toEqual({ops: server});
      }
    }
  };

  await t([
    {
      client: [
        {
          op: 'insert',
          tableName: 'issue',
          primaryKey: ['id'],
          value: {id: 'foo', ownerId: 'bar', closed: true},
        },
        {
          op: 'update',
          tableName: 'comment',
          primaryKey: ['id'],
          value: {id: 'baz', issueId: 'foo', description: 'boom'},
        },
        {
          op: 'upsert',
          tableName: 'compoundPKTest',
          primaryKey: ['id1', 'id2'],
          value: {id1: 'voo', id2: 'doo', text: 'zoo'},
        },
        {
          op: 'delete',
          tableName: 'comment',
          primaryKey: ['id'],
          value: {id: 'boo'},
        },
      ],

      server: [
        {
          op: 'insert',
          tableName: 'issues',
          primaryKey: ['id'],
          value: {id: 'foo', ownerId: 'bar', closed: true},
        },
        {
          op: 'update',
          tableName: 'comments',
          primaryKey: ['id'],
          value: {id: 'baz', ['issue_id']: 'foo', description: 'boom'},
        },
        {
          op: 'upsert',
          tableName: 'compoundPKTest',
          primaryKey: ['id_1', 'id_2'],
          value: {['id_1']: 'voo', ['id_2']: 'doo', text: 'zoo'},
        },
        {
          op: 'delete',
          tableName: 'comments',
          primaryKey: ['id'],
          value: {id: 'boo'},
        },
      ],
    },
  ]);
});

test('pusher adjusts mutation timestamps to be unix timestamps', async () => {
  const r = zeroForTest();
  await r.triggerConnected();

  const mockSocket = await r.socket;
  clock.tick(300); // performance.now is 500, system time is startTime + 300

  const mutations = [
    {clientID: 'c1', id: 1, name: 'mut1', args: [{d: 1}], timestamp: 100},
    {clientID: 'c2', id: 1, name: 'mut1', args: [{d: 2}], timestamp: 200},
  ];
  const requestID = 'test-request-id';

  const pushReq: PushRequest = {
    profileID: 'p1',
    clientGroupID: await r.clientGroupID,
    pushVersion: 1,
    schemaVersion: '1',
    mutations,
  };

  mockSocket.messages.length = 0;

  await r.pusher(pushReq, requestID);

  expect(mockSocket.messages).to.have.lengthOf(mutations.length);
  const push0 = valita.parse(
    JSON.parse(mockSocket.messages[0]),
    pushMessageSchema,
  );
  expect(push0[1].mutations[0].timestamp).to.equal(startTime + 100);
  const push1 = valita.parse(
    JSON.parse(mockSocket.messages[1]),
    pushMessageSchema,
  );
  expect(push1[1].mutations[0].timestamp).to.equal(startTime + 200);
});

test('puller with mutation recovery pull, success response', async () => {
  const r = zeroForTest();
  await r.triggerConnected();

  const mockSocket = await r.socket;

  const pullReq: PullRequest = {
    profileID: 'test-profile-id',
    clientGroupID: 'test-client-group-id',
    cookie: '1',
    pullVersion: 1,
    schemaVersion: r.schemaVersion,
  };
  mockSocket.messages.length = 0;

  const resultPromise = r.puller(pullReq, 'test-request-id');

  await tickAFewTimes(clock);
  expect(mockSocket.messages.length).to.equal(1);
  expect(JSON.parse(mockSocket.messages[0])).to.deep.equal([
    'pull',
    {
      clientGroupID: 'test-client-group-id',
      cookie: '1',
      requestID: 'test-request-id',
    },
  ]);

  await r.triggerPullResponse({
    cookie: '2',
    requestID: 'test-request-id',
    lastMutationIDChanges: {cid1: 1},
  });

  const result = await resultPromise;

  expect(result).to.deep.equal({
    response: {
      cookie: '2',
      lastMutationIDChanges: {cid1: 1},
      patch: [],
    },
    httpRequestInfo: {
      errorMessage: '',
      httpStatusCode: 200,
    },
  });
});

test('puller with mutation recovery pull, response timeout', async () => {
  const r = zeroForTest();
  await r.triggerConnected();

  const mockSocket = await r.socket;

  const pullReq: PullRequest = {
    profileID: 'test-profile-id',
    clientGroupID: 'test-client-group-id',
    cookie: '1',
    pullVersion: 1,
    schemaVersion: r.schemaVersion,
  };
  mockSocket.messages.length = 0;

  const resultPromise = r.puller(pullReq, 'test-request-id');

  await tickAFewTimes(clock);
  expect(mockSocket.messages.length).to.equal(1);
  expect(JSON.parse(mockSocket.messages[0])).to.deep.equal([
    'pull',
    {
      clientGroupID: 'test-client-group-id',
      cookie: '1',
      requestID: 'test-request-id',
    },
  ]);

  clock.tick(PULL_TIMEOUT_MS);

  let expectedE = undefined;
  try {
    await resultPromise;
  } catch (e) {
    expectedE = e;
  }
  expect(expectedE).property('message', 'Pull timed out');
});

test('puller with normal non-mutation recovery pull', async () => {
  const r = zeroForTest();
  const pullReq: PullRequest = {
    profileID: 'test-profile-id',
    clientGroupID: await r.clientGroupID,
    cookie: '1',
    pullVersion: 1,
    schemaVersion: r.schemaVersion,
  };

  const result = await r.puller(pullReq, 'test-request-id');
  expect(fetchStub.notCalled).true;
  expect(result).to.deep.equal({
    httpRequestInfo: {
      errorMessage: '',
      httpStatusCode: 200,
    },
  });
});

test('smokeTest', async () => {
  const cases: {
    name: string;
    enableServer: boolean;
  }[] = [
    {
      name: 'socket enabled',
      enableServer: true,
    },
    {
      name: 'socket disabled',
      enableServer: false,
    },
  ];

  for (const c of cases) {
    // zeroForTest adds the socket by default.
    const serverOptions = c.enableServer ? {} : {server: null};
    const r = zeroForTest({
      ...serverOptions,
      schema: createSchema(1, {
        tables: [
          table('issues')
            .columns({
              id: string(),
              value: number(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    const calls: Array<Array<unknown>> = [];
    const view = r.query.issues.materialize();
    const unsubscribe = view.addListener(c => {
      calls.push([...c]);
    });

    await r.mutate.issues.insert({id: 'a', value: 1});
    await r.mutate.issues.insert({id: 'b', value: 2});

    // we get called for initial hydration, even though there's no data.
    // plus once for the each transaction
    // we test multiple changes in a transactions below
    expect(calls.length).eq(3);
    expect(calls[0]).toEqual([]);
    expect(calls[1]).toEqual([{id: 'a', value: 1}]);
    expect(calls[2]).toEqual([
      {id: 'a', value: 1},
      {id: 'b', value: 2},
    ]);

    calls.length = 0;

    await r.mutate.issues.insert({id: 'a', value: 1});
    await r.mutate.issues.insert({id: 'b', value: 2});

    expect(calls.length).eq(0);

    await r.mutate.issues.upsert({id: 'a', value: 11});

    // Although the set() results in a remove and add flowing through the pipeline,
    // they are in same tx, so we only get one call coming out.
    expect(calls.length).eq(1);
    expect(calls[0]).toEqual([
      {id: 'a', value: 11},
      {id: 'b', value: 2},
    ]);

    calls.length = 0;
    await r.mutate.issues.delete({id: 'b'});
    expect(calls.length).eq(1);
    expect(calls[0]).toEqual([{id: 'a', value: 11}]);

    unsubscribe();

    calls.length = 0;
    await r.mutate.issues.insert({id: 'c', value: 6});
    expect(calls.length).eq(0);
  }
});

// TODO: Reenable metrics
// test('Metrics', async () => {
//   // This is just a smoke test -- it ensures that we send metrics once at startup.
//   // Ideally we would run Zero and put it into different error conditions and see
//   // that the metrics are reported appropriately.

//   const r = zeroForTest();
//   await r.waitForConnectionState(ConnectionState.Connecting);
//   await r.triggerConnected();
//   await r.waitForConnectionState(ConnectionState.Connected);

//   for (let t = 0; t < REPORT_INTERVAL_MS; t += PING_INTERVAL_MS) {
//     await clock.tickAsync(PING_INTERVAL_MS);
//     await r.triggerPong();
//   }

//   expect(
//     fetchStub.calledWithMatch(
//       sinon.match(new RegExp('^https://example.com/api/metrics/v0/report?.*')),
//     ),
//   ).to.be.true;
// });

// test('Metrics not reported when enableAnalytics is false', async () => {
//   const r = zeroForTest({enableAnalytics: false});
//   await r.waitForConnectionState(ConnectionState.Connecting);
//   await r.triggerConnected();
//   await r.waitForConnectionState(ConnectionState.Connected);

//   for (let t = 0; t < REPORT_INTERVAL_MS; t += PING_INTERVAL_MS) {
//     await clock.tickAsync(PING_INTERVAL_MS);
//     await r.triggerPong();
//   }

//   expect(
//     fetchStub.calledWithMatch(
//       sinon.match(new RegExp('^https://example.com/api/metrics/v0/report?.*')),
//     ),
//   ).to.be.false;
// });

// test('Metrics not reported when server indicates local development', async () => {
//   const r = zeroForTest({server: 'http://localhost:8000'});
//   await r.waitForConnectionState(ConnectionState.Connecting);
//   await r.triggerConnected();
//   await r.waitForConnectionState(ConnectionState.Connected);

//   for (let t = 0; t < REPORT_INTERVAL_MS; t += PING_INTERVAL_MS) {
//     await clock.tickAsync(PING_INTERVAL_MS);
//     await r.triggerPong();
//   }

//   expect(
//     fetchStub.calledWithMatch(
//       sinon.match(new RegExp('^https://example.com/api/metrics/v0/report?.*')),
//     ),
//   ).to.be.false;
// });

test('Authentication', async () => {
  const log: number[] = [];

  let authCounter = 0;

  const auth = () => {
    if (authCounter > 0) {
      log.push(Date.now());
    }

    if (authCounter++ > 3) {
      return `new-auth-token-${authCounter}`;
    }
    return 'auth-token';
  };

  const r = zeroForTest({auth});

  const emulateErrorWhenConnecting = async (
    tickMS: number,
    expectedAuthToken: string,
    expectedTimeOfCall: number,
  ) => {
    expect(decodeSecProtocols((await r.socket).protocol).authToken).equal(
      expectedAuthToken,
    );
    await r.triggerError(ErrorKind.Unauthorized, 'auth error ' + authCounter);
    expect(r.connectionState).equal(ConnectionState.Disconnected);
    await clock.tickAsync(tickMS);
    expect(log).length(1);
    expect(log[0]).equal(expectedTimeOfCall);
    log.length = 0;
  };

  await emulateErrorWhenConnecting(0, 'auth-token', startTime);
  await emulateErrorWhenConnecting(5_000, 'auth-token', startTime + 5_000);
  await emulateErrorWhenConnecting(5_000, 'auth-token', startTime + 10_000);
  await emulateErrorWhenConnecting(5_000, 'auth-token', startTime + 15_000);
  await emulateErrorWhenConnecting(
    5_000,
    'new-auth-token-5',
    startTime + 20_000,
  );
  await emulateErrorWhenConnecting(
    5_000,
    'new-auth-token-6',
    startTime + 25_000,
  );
  await emulateErrorWhenConnecting(
    5_000,
    'new-auth-token-7',
    startTime + 30_000,
  );

  let socket: MockSocket | undefined;
  {
    await r.waitForConnectionState(ConnectionState.Connecting);
    socket = await r.socket;
    expect(decodeSecProtocols(socket.protocol).authToken).equal(
      'new-auth-token-8',
    );
    await r.triggerConnected();
    await r.waitForConnectionState(ConnectionState.Connected);
    // getAuth should not be called again.
    expect(log).empty;
  }

  {
    // Ping/pong should happen every 5 seconds.
    await tickAFewTimes(clock, PING_INTERVAL_MS);
    const socket = await r.socket;
    expect(socket.messages[0]).deep.equal(JSON.stringify(['ping', {}]));
    expect(r.connectionState).equal(ConnectionState.Connected);
    await r.triggerPong();
    expect(r.connectionState).equal(ConnectionState.Connected);
    // getAuth should not be called again.
    expect(log).empty;
    // Socket is kept as long as we are connected.
    expect(await r.socket).equal(socket);
  }
});

test(ErrorKind.AuthInvalidated, async () => {
  // In steady state we can get an AuthInvalidated error if the tokens expire on the server.
  // At this point we should disconnect and reconnect with a new auth token.

  let authCounter = 1;

  const r = zeroForTest({
    auth: () => `auth-token-${authCounter++}`,
  });

  await r.triggerConnected();
  expect(decodeSecProtocols((await r.socket).protocol).authToken).equal(
    'auth-token-1',
  );

  await r.triggerError(ErrorKind.AuthInvalidated, 'auth error');
  await r.waitForConnectionState(ConnectionState.Disconnected);

  await r.waitForConnectionState(ConnectionState.Connecting);
  expect(decodeSecProtocols((await r.socket).protocol).authToken).equal(
    'auth-token-2',
  );
});

test('Disconnect on error', async () => {
  const r = zeroForTest();
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  await r.triggerError(ErrorKind.InvalidMessage, 'Bad message');
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
});

test('No backoff on errors', async () => {
  const r = zeroForTest();
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);

  const step = async (delta: number, message: string) => {
    await r.triggerError(ErrorKind.InvalidMessage, message);
    expect(r.connectionState).to.equal(ConnectionState.Disconnected);

    await clock.tickAsync(delta - 1);
    expect(r.connectionState).to.equal(ConnectionState.Disconnected);
    await clock.tickAsync(1);
    expect(r.connectionState).to.equal(ConnectionState.Connecting);
  };

  const steps = async () => {
    await step(5_000, 'a');
    await step(5_000, 'a');
    await step(5_000, 'a');
    await step(5_000, 'a');
  };

  await steps();

  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);

  await steps();
});

test('Ping pong', async () => {
  const r = zeroForTest();
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  (await r.socket).messages.length = 0;

  await clock.tickAsync(PING_INTERVAL_MS - 1);
  expect((await r.socket).messages).empty;
  await clock.tickAsync(1);

  expect((await r.socket).messages).deep.equal([JSON.stringify(['ping', {}])]);
  await clock.tickAsync(PING_TIMEOUT_MS - 1);
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  await clock.tickAsync(1);

  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
});

test('Ping timeout', async () => {
  const r = zeroForTest();
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  (await r.socket).messages.length = 0;

  await clock.tickAsync(PING_INTERVAL_MS - 1);
  expect((await r.socket).messages).empty;
  await clock.tickAsync(1);
  expect((await r.socket).messages).deep.equal([JSON.stringify(['ping', {}])]);
  await clock.tickAsync(PING_TIMEOUT_MS - 1);
  await r.triggerPong();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  await clock.tickAsync(1);
  expect(r.connectionState).to.equal(ConnectionState.Connected);
});

const connectTimeoutMessage = 'Rejecting connect resolver due to timeout';

function expectLogMessages(r: TestZero<Schema>) {
  return expect(
    r.testLogSink.messages.flatMap(([level, _context, msg]) =>
      level === 'debug' ? msg : [],
    ),
  );
}

test('Connect timeout', async () => {
  const r = zeroForTest({logLevel: 'debug'});

  await r.waitForConnectionState(ConnectionState.Connecting);

  const step = async (sleepMS: number) => {
    // Need to drain the microtask queue without changing the clock because we are
    // using the time below to check when the connect times out.
    for (let i = 0; i < 10; i++) {
      await clock.tickAsync(0);
    }

    expect(r.connectionState).to.equal(ConnectionState.Connecting);
    await clock.tickAsync(CONNECT_TIMEOUT_MS - 1);
    expect(r.connectionState).to.equal(ConnectionState.Connecting);
    await clock.tickAsync(1);
    expect(r.connectionState).to.equal(ConnectionState.Disconnected);
    expectLogMessages(r).contain(connectTimeoutMessage);

    // We got disconnected so we sleep for RUN_LOOP_INTERVAL_MS before trying again

    await clock.tickAsync(sleepMS - 1);
    expect(r.connectionState).to.equal(ConnectionState.Disconnected);
    await clock.tickAsync(1);
    expect(r.connectionState).to.equal(ConnectionState.Connecting);
  };

  await step(RUN_LOOP_INTERVAL_MS);

  // Try again to connect
  await step(RUN_LOOP_INTERVAL_MS);
  await step(RUN_LOOP_INTERVAL_MS);
  await step(RUN_LOOP_INTERVAL_MS);

  // And success after this...
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
});

test('socketOrigin', async () => {
  const cases: {
    name: string;
    socketEnabled: boolean;
  }[] = [
    {
      name: 'socket enabled',
      socketEnabled: true,
    },
    {
      name: 'socket disabled',
      socketEnabled: false,
    },
  ];

  for (const c of cases) {
    const r = zeroForTest(c.socketEnabled ? {} : {server: null});

    await tickAFewTimes(clock);

    expect(r.connectionState, c.name).to.equal(
      c.socketEnabled
        ? ConnectionState.Connecting
        : ConnectionState.Disconnected,
    );
  }
});

test('Logs errors in connect', async () => {
  const r = zeroForTest({});
  await r.triggerError(ErrorKind.InvalidMessage, 'bad-message');
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
  await clock.tickAsync(0);

  const index = r.testLogSink.messages.findIndex(
    ([level, _context, args]) =>
      level === 'error' && args.find(arg => /bad-message/.test(String(arg))),
  );

  expect(index).to.not.equal(-1);
});

test('New connection logs', async () => {
  clock.setSystemTime(1000);
  const r = zeroForTest({logLevel: 'info'});
  await r.waitForConnectionState(ConnectionState.Connecting);
  await clock.tickAsync(500);
  await r.triggerConnected();
  expect(r.connectionState).to.equal(ConnectionState.Connected);
  await clock.tickAsync(500);
  await r.triggerPong();
  await r.triggerClose();
  await r.waitForConnectionState(ConnectionState.Disconnected);
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
  const connectIndex = r.testLogSink.messages.findIndex(
    ([level, _context, args]) =>
      level === 'info' &&
      args.find(arg => /Connected/.test(String(arg))) &&
      args.find(
        arg =>
          arg instanceof Object &&
          (arg as {timeToConnectMs: number}).timeToConnectMs === 500,
      ),
  );

  const disconnectIndex = r.testLogSink.messages.findIndex(
    ([level, _context, args]) =>
      level === 'info' &&
      args.find(arg => /disconnecting/.test(String(arg))) &&
      args.find(
        arg =>
          arg instanceof Object &&
          (arg as {connectedAt: number}).connectedAt === 1500 &&
          (arg as {connectionDuration: number}).connectionDuration === 500 &&
          (arg as {messageCount: number}).messageCount === 2,
      ),
  );
  expect(connectIndex).to.not.equal(-1);
  expect(disconnectIndex).to.not.equal(-1);
});

async function testWaitsForConnection(
  fn: (r: TestZero<Schema>) => Promise<unknown>,
) {
  const r = zeroForTest();

  const log: ('resolved' | 'rejected')[] = [];

  await r.triggerError(ErrorKind.InvalidMessage, 'Bad message');
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  fn(r).then(
    () => log.push('resolved'),
    () => log.push('rejected'),
  );

  await tickAFewTimes(clock);

  // Rejections that happened in previous connect should not reject pusher.
  expect(log).to.deep.equal([]);

  await clock.tickAsync(RUN_LOOP_INTERVAL_MS);
  expect(r.connectionState).to.equal(ConnectionState.Connecting);

  await r.triggerError(ErrorKind.InvalidMessage, 'Bad message');
  await tickAFewTimes(clock);
  expect(log).to.deep.equal(['rejected']);
}

test('pusher waits for connection', async () => {
  await testWaitsForConnection(async r => {
    const pushReq: PushRequest = {
      profileID: 'p1',
      clientGroupID: await r.clientGroupID,
      pushVersion: 1,
      schemaVersion: '1',
      mutations: [],
    };
    return r.pusher(pushReq, 'request-id');
  });
});

test('puller waits for connection', async () => {
  await testWaitsForConnection(r => {
    const pullReq: PullRequest = {
      profileID: 'test-profile-id',
      clientGroupID: 'test-client-group-id',
      cookie: 1,
      pullVersion: 1,
      schemaVersion: r.schemaVersion,
    };
    return r.puller(pullReq, 'request-id');
  });
});

test('VersionNotSupported default handler', async () => {
  const storage: Record<string, string> = {};
  sinon.replaceGetter(window, 'sessionStorage', () => storageMock(storage));
  const {promise, resolve} = resolver();
  const fake = sinon.fake(resolve);
  const r = zeroForTest(undefined, false);
  r.reload = fake;

  await r.triggerError(ErrorKind.VersionNotSupported, 'server test message');
  await clock.nextAsync();
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;

  expect(storage[RELOAD_REASON_STORAGE_KEY]).to.equal(
    "The server no longer supports this client's protocol version. server test message",
  );
});

test('VersionNotSupported custom onUpdateNeeded handler', async () => {
  const {promise, resolve} = resolver();
  const fake = sinon.fake((_reason: UpdateNeededReason) => {
    resolve();
  });
  const r = zeroForTest({onUpdateNeeded: fake});

  await r.triggerError(ErrorKind.VersionNotSupported, 'server test message');
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;
});

test('SchemaVersionNotSupported default handler', async () => {
  const storage: Record<string, string> = {};
  sinon.replaceGetter(window, 'sessionStorage', () => storageMock(storage));
  const {promise, resolve} = resolver();
  const fake = sinon.fake(resolve);
  const r = zeroForTest(undefined, false);
  r.reload = fake;

  await r.triggerError(
    ErrorKind.SchemaVersionNotSupported,
    'server test message',
  );
  await clock.nextAsync();
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;

  expect(storage[RELOAD_REASON_STORAGE_KEY]).to.equal(
    "The server no longer supports this client's schema version. server test message",
  );
});

test('SchemaVersionNotSupported custom onUpdateNeeded handler', async () => {
  const {promise, resolve} = resolver();
  const fake = sinon.fake((_reason: UpdateNeededReason) => {
    resolve();
  });
  const r = zeroForTest({onUpdateNeeded: fake});

  await r.triggerError(
    ErrorKind.SchemaVersionNotSupported,
    'server test message',
  );
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;
});

test('ClientNotFound default handler', async () => {
  const storage: Record<string, string> = {};
  sinon.replaceGetter(window, 'sessionStorage', () => storageMock(storage));
  const {promise, resolve} = resolver();
  const fake = sinon.fake(resolve);
  const r = zeroForTest(undefined, false);
  r.reload = fake;

  await r.triggerError(ErrorKind.ClientNotFound, 'server test message');
  await clock.nextAsync();
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;

  expect(storage[RELOAD_REASON_STORAGE_KEY]).to.equal(
    'Server could not find state needed to synchronize this client. server test message',
  );
});

test('ClientNotFound custom onClientStateNotFound handler', async () => {
  const {promise, resolve} = resolver();
  const fake = sinon.fake(() => {
    resolve();
  });
  const r = zeroForTest({onClientStateNotFound: fake});
  await r.triggerError(ErrorKind.ClientNotFound, 'server test message');
  await promise;
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);

  expect(fake.calledOnce).true;
});

test('server ahead', async () => {
  const {promise, resolve} = resolver();
  const storage: Record<string, string> = {};
  sinon.replaceGetter(window, 'sessionStorage', () => storageMock(storage));
  const r = zeroForTest();
  r.reload = resolve;

  await r.triggerError(
    ErrorKind.InvalidConnectionRequestBaseCookie,
    'unexpected BaseCookie',
  );
  // There are a lot of timers that get scheduled before the reload timer
  // for dropping the database. TODO: Make this more robust.
  for (let i = 0; i < 8; i++) {
    await clock.nextAsync();
  }
  await promise;

  expect(storage[RELOAD_REASON_STORAGE_KEY]).to.equal(
    'Server reported that client is ahead of server (InvalidConnectionRequestBaseCookie). This probably happened because the server is in development mode and restarted. Currently when this happens, the dev server loses its state and on reconnect sees the client as ahead. If you see this in other cases, it may be a bug in Zero.',
  );
});

test('Constructing Zero with a negative hiddenTabDisconnectDelay option throws an error', () => {
  let expected;
  try {
    zeroForTest({hiddenTabDisconnectDelay: -1});
  } catch (e) {
    expected = e;
  }
  expect(expected)
    .instanceOf(Error)
    .property(
      'message',
      'ZeroOptions.hiddenTabDisconnectDelay must not be negative.',
    );
});

suite('Disconnect on hide', () => {
  type Case = {
    name: string;
    hiddenTabDisconnectDelay?: number | undefined;
    test: (
      r: TestZero<Schema>,
      changeVisibilityState: (
        newVisibilityState: DocumentVisibilityState,
      ) => void,
    ) => Promise<void>;
  };

  const cases: Case[] = [
    {
      name: 'default delay not during ping',
      test: async (r, changeVisibilityState) => {
        expect(PING_INTERVAL_MS).lessThanOrEqual(
          DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
        );
        expect(PING_INTERVAL_MS * 2).greaterThanOrEqual(
          DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
        );
        let timeTillHiddenDisconnect = DEFAULT_DISCONNECT_HIDDEN_DELAY_MS;
        changeVisibilityState('hidden');
        await clock.tickAsync(PING_INTERVAL_MS); // sends ping
        timeTillHiddenDisconnect -= PING_INTERVAL_MS;
        await r.triggerPong();
        await clock.tickAsync(timeTillHiddenDisconnect);
      },
    },
    {
      name: 'default delay during ping',
      test: async (r, changeVisibilityState) => {
        expect(PING_INTERVAL_MS).lessThanOrEqual(
          DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
        );
        expect(PING_INTERVAL_MS + PING_TIMEOUT_MS).greaterThanOrEqual(
          DEFAULT_DISCONNECT_HIDDEN_DELAY_MS,
        );
        await clock.tickAsync(PING_INTERVAL_MS / 2);
        let timeTillHiddenDisconnect = DEFAULT_DISCONNECT_HIDDEN_DELAY_MS;
        changeVisibilityState('hidden');
        await clock.tickAsync(PING_INTERVAL_MS / 2); // sends ping
        timeTillHiddenDisconnect -= PING_INTERVAL_MS / 2;
        await clock.tickAsync(timeTillHiddenDisconnect);
        // Disconnect due to visibility does not happen until pong is received
        // and microtask queue is processed.
        expect(r.connectionState).to.equal(ConnectionState.Connected);
        await r.triggerPong();
        await clock.tickAsync(0);
      },
    },
    {
      name: 'custom delay longer than ping interval not during ping',
      hiddenTabDisconnectDelay: Math.floor(PING_INTERVAL_MS * 6.3),
      test: async (r, changeVisibilityState) => {
        let timeTillHiddenDisconnect = Math.floor(PING_INTERVAL_MS * 6.3);
        changeVisibilityState('hidden');
        while (timeTillHiddenDisconnect > PING_INTERVAL_MS) {
          await clock.tickAsync(PING_INTERVAL_MS); // sends ping
          timeTillHiddenDisconnect -= PING_INTERVAL_MS;
          await r.triggerPong();
        }
        await clock.tickAsync(timeTillHiddenDisconnect);
      },
    },
    {
      name: 'custom delay longer than ping interval during ping',
      hiddenTabDisconnectDelay: Math.floor(PING_INTERVAL_MS * 6.3),
      test: async (r, changeVisibilityState) => {
        let timeTillHiddenDisconnect = Math.floor(PING_INTERVAL_MS * 6.3);
        expect(timeTillHiddenDisconnect > PING_INTERVAL_MS + PING_TIMEOUT_MS);
        changeVisibilityState('hidden');
        while (timeTillHiddenDisconnect > PING_INTERVAL_MS + PING_TIMEOUT_MS) {
          await clock.tickAsync(PING_INTERVAL_MS);
          timeTillHiddenDisconnect -= PING_INTERVAL_MS;
          await r.triggerPong();
        }
        expect(timeTillHiddenDisconnect).lessThan(
          PING_INTERVAL_MS + PING_TIMEOUT_MS,
        );
        expect(timeTillHiddenDisconnect).greaterThan(PING_INTERVAL_MS);
        await clock.tickAsync(PING_INTERVAL_MS); // sends ping
        timeTillHiddenDisconnect -= PING_INTERVAL_MS;
        await clock.tickAsync(timeTillHiddenDisconnect);
        // Disconnect due to visibility does not happen until pong is received
        // and microtask queue is processed.
        expect(r.connectionState).to.equal(ConnectionState.Connected);
        await r.triggerPong();
        await clock.tickAsync(0);
      },
    },
    {
      name: 'custom delay shorter than ping interval not during ping',
      hiddenTabDisconnectDelay: Math.floor(PING_INTERVAL_MS * 0.3),
      test: async (r, changeVisibilityState) => {
        await clock.tickAsync(PING_INTERVAL_MS);
        await r.triggerPong();
        const timeTillHiddenDisconnect = Math.floor(PING_INTERVAL_MS * 0.3);
        changeVisibilityState('hidden');
        await clock.tickAsync(timeTillHiddenDisconnect);
      },
    },
    {
      name: 'custom delay shorter than ping interval during ping',
      hiddenTabDisconnectDelay: Math.floor(PING_INTERVAL_MS * 0.3),
      test: async (r, changeVisibilityState) => {
        await clock.tickAsync(PING_INTERVAL_MS);
        const timeTillHiddenDisconnect = Math.floor(PING_INTERVAL_MS * 0.3);
        changeVisibilityState('hidden');
        await clock.tickAsync(timeTillHiddenDisconnect);
        // Disconnect due to visibility does not happen until pong is received
        // and microtask queue is processed.
        expect(r.connectionState).to.equal(ConnectionState.Connected);
        await r.triggerPong();
        await clock.tickAsync(0);
      },
    },
    {
      name: 'custom delay 0, not during ping',
      hiddenTabDisconnectDelay: 0,
      test: async (r, changeVisibilityState) => {
        await clock.tickAsync(PING_INTERVAL_MS);
        await r.triggerPong();
        changeVisibilityState('hidden');
        await clock.tickAsync(0);
      },
    },
    {
      name: 'custom delay 0, during ping',
      hiddenTabDisconnectDelay: 0,
      test: async (r, changeVisibilityState) => {
        await clock.tickAsync(PING_INTERVAL_MS);
        changeVisibilityState('hidden');
        await clock.tickAsync(0);
        // Disconnect due to visibility does not happen until pong is received
        // and microtask queue is processed.
        expect(r.connectionState).to.equal(ConnectionState.Connected);
        await r.triggerPong();
        await clock.tickAsync(0);
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const {hiddenTabDisconnectDelay} = c;

      let visibilityState = 'visible';
      sinon.stub(document, 'visibilityState').get(() => visibilityState);
      const changeVisibilityState = (
        newVisibilityState: DocumentVisibilityState,
      ) => {
        assert(visibilityState !== newVisibilityState);
        visibilityState = newVisibilityState;
        document.dispatchEvent(new Event('visibilitychange'));
      };

      let resolveOnlineChangePromise: (v: boolean) => void = () => {};

      const r = zeroForTest({
        hiddenTabDisconnectDelay,
        onOnlineChange: online => {
          resolveOnlineChangePromise(online);
        },
      });
      const makeOnOnlineChangePromise = () =>
        new Promise(resolve => {
          resolveOnlineChangePromise = resolve;
        });
      let onOnlineChangeP = makeOnOnlineChangePromise();

      await r.triggerConnected();
      expect(r.connectionState).to.equal(ConnectionState.Connected);
      expect(await onOnlineChangeP).true;
      expect(r.online).true;

      onOnlineChangeP = makeOnOnlineChangePromise();

      await c.test(r, changeVisibilityState);

      expect(r.connectionState).to.equal(ConnectionState.Disconnected);
      expect(await onOnlineChangeP).false;
      expect(r.online).false;

      // Stays disconnected as long as we are hidden.
      while (Date.now() < 100_000) {
        await clock.tickAsync(1_000);
        expect(r.connectionState).to.equal(ConnectionState.Disconnected);
        expect(r.online).false;
        expect(document.visibilityState).to.equal('hidden');
      }

      onOnlineChangeP = makeOnOnlineChangePromise();

      visibilityState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));

      await r.waitForConnectionState(ConnectionState.Connecting);
      await r.triggerConnected();
      expect(r.connectionState).to.equal(ConnectionState.Connected);
      expect(await onOnlineChangeP).true;
      expect(r.online).true;
    });
  }
});

test(ErrorKind.InvalidConnectionRequest, async () => {
  const r = zeroForTest({});
  await r.triggerError(ErrorKind.InvalidConnectionRequest, 'test');
  expect(r.connectionState).to.equal(ConnectionState.Disconnected);
  await clock.tickAsync(0);
  const msg = r.testLogSink.messages.at(-1);
  assert(msg);

  expect(msg[0]).equal('error');

  const err = msg[2].at(-2);
  assert(err instanceof ServerError);
  expect(err.message).equal('InvalidConnectionRequest: test');

  const data = msg[2].at(-1);
  expect(data).deep.equal({
    lmid: 0,
    baseCookie: null,
  });
});

suite('Invalid Downstream message', () => {
  type Case = {
    name: string;
    duringPing: boolean;
  };

  const cases: Case[] = [
    {name: 'no ping', duringPing: false},
    {name: 'during ping', duringPing: true},
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const r = zeroForTest({
        logLevel: 'debug',
      });
      await r.triggerConnected();
      expect(r.connectionState).to.equal(ConnectionState.Connected);

      if (c.duringPing) {
        await waitForUpstreamMessage(r, 'ping', clock);
      }

      await r.triggerPokeStart({
        // @ts-expect-error - invalid field
        pokeIDXX: '1',
        baseCookie: null,
        cookie: '1',
        timestamp: 123456,
      });
      await clock.tickAsync(0);

      if (c.duringPing) {
        await r.triggerPong();
      }

      expect(r.online).eq(true);
      expect(r.connectionState).eq(ConnectionState.Connected);

      const found = r.testLogSink.messages.some(m =>
        m[2].some(
          v =>
            v instanceof Error && v.message.includes('Missing property pokeID'),
        ),
      );
      expect(found).true;
    });
  }
});

test('kvStore option', async () => {
  const spy = sinon.spy(IDBFactory.prototype, 'open');

  type E = {
    id: string;
    value: number;
  };

  const t = async <S extends Schema>(
    kvStore: ZeroOptions<S>['kvStore'],
    userID: string,
    expectedIDBOpenCalled: boolean,
    expectedValue: E[],
  ) => {
    const r = zeroForTest({
      server: null,
      userID,
      kvStore,
      schema: createSchema(1, {
        tables: [
          table('e')
            .columns({
              id: string(),
              value: number(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    // Use persist as a way to ensure we have read the data out of IDB.
    await r.persist();

    const idIsAView = r.query.e.where('id', '=', 'a').materialize();
    const allDataView = r.query.e.materialize();
    expect(allDataView.data).deep.equal(expectedValue);

    await r.mutate.e.insert({id: 'a', value: 1});

    expect(idIsAView.data).deep.equal([{id: 'a', value: 1}]);
    // Wait for persist to finish
    await r.persist();

    await r.close();
    expect(spy.called).equal(expectedIDBOpenCalled, 'IDB existed!');

    spy.resetHistory();
  };

  const uuid = Math.random().toString().slice(2);

  await t('idb', 'kv-store-test-user-id-1' + uuid, true, []);
  await t('idb', 'kv-store-test-user-id-1' + uuid, true, [{id: 'a', value: 1}]);
  await t('mem', 'kv-store-test-user-id-2' + uuid, false, []);
  // Defaults to idb
  await t(undefined, 'kv-store-test-user-id-3' + uuid, true, []);
});

test('Close during connect should sleep', async () => {
  const r = zeroForTest({
    logLevel: 'debug',
  });

  await r.triggerConnected();

  await r.waitForConnectionState(ConnectionState.Connected);
  await clock.tickAsync(0);
  expect(r.online).equal(true);

  (await r.socket).close();
  await r.waitForConnectionState(ConnectionState.Disconnected);
  await r.waitForConnectionState(ConnectionState.Connecting);

  (await r.socket).close();
  await r.waitForConnectionState(ConnectionState.Disconnected);
  await clock.tickAsync(0);
  expect(r.online).equal(false);
  const hasSleeping = r.testLogSink.messages.some(m =>
    m[2].some(v => v === 'Sleeping'),
  );
  expect(hasSleeping).true;

  await clock.tickAsync(RUN_LOOP_INTERVAL_MS);

  await r.waitForConnectionState(ConnectionState.Connecting);
  await r.triggerConnected();
  await r.waitForConnectionState(ConnectionState.Connected);
  await clock.tickAsync(0);
  expect(r.online).equal(true);
});

test('Zero close should stop timeout', async () => {
  const r = zeroForTest({
    logLevel: 'debug',
  });

  await r.waitForConnectionState(ConnectionState.Connecting);
  await r.close();
  await clock.tickAsync(CONNECT_TIMEOUT_MS);
  expectLogMessages(r).not.contain(connectTimeoutMessage);
});

test('Zero close should stop timeout, close delayed', async () => {
  const r = zeroForTest({
    logLevel: 'debug',
  });

  await r.waitForConnectionState(ConnectionState.Connecting);
  await clock.tickAsync(CONNECT_TIMEOUT_MS / 2);
  await r.close();
  await clock.tickAsync(CONNECT_TIMEOUT_MS / 2);
  expectLogMessages(r).not.contain(connectTimeoutMessage);
});

test('ensure we get the same query object back', () => {
  const z = zeroForTest({
    schema: createSchema(1, {
      tables: [
        table('issue')
          .columns({
            id: string(),
            title: string(),
          })
          .primaryKey('id'),
        table('comment')
          .columns({
            id: string(),
            issueID: string(),
            text: string(),
          })
          .primaryKey('id'),
      ],
    }),
  });
  const issueQuery1 = z.query.issue;
  const issueQuery2 = z.query.issue;
  expect(issueQuery1).to.equal(issueQuery2);

  const commentQuery1 = z.query.comment;
  const commentQuery2 = z.query.comment;
  expect(commentQuery1).to.equal(commentQuery2);

  expect(issueQuery1).to.not.equal(commentQuery1);
});

test('the type of collection should be inferred from options with parse', () => {
  const r = zeroForTest({
    schema: createSchema(1, {
      tables: [
        table('issue')
          .columns({
            id: string(),
            title: string(),
          })
          .primaryKey('id'),
        table('comment')
          .columns({
            id: string(),
            issueID: string(),
            text: string(),
          })
          .primaryKey('id'),
      ],
    }),
  });

  const c = r.query;
  expect(c).not.undefined;

  const issueQ = r.query.issue;
  const commentQ = r.query.comment;
  expect(issueQ).not.undefined;
  expect(commentQ).not.undefined;
});

suite('CRUD', () => {
  const makeZero = () =>
    zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('issue')
            .from('issues')
            .columns({
              id: string(),
              title: string().optional(),
            })
            .primaryKey('id'),
          table('comment')
            .from('comments')
            .columns({
              id: string(),
              issueID: string().from('issue_id'),
              text: string().optional(),
            })
            .primaryKey('id'),
          table('compoundPKTest')
            .columns({
              id1: string(),
              id2: string(),
              text: string(),
            })
            .primaryKey('id1', 'id2'),
        ],
      }),
    });

  test('create', async () => {
    const z = makeZero();

    const createIssue = z.mutate.issue.insert;
    const view = z.query.issue.materialize();
    await createIssue({id: 'a', title: 'A'});
    expect(view.data).toEqual([{id: 'a', title: 'A'}]);

    // create again should not change anything
    await createIssue({id: 'a', title: 'Again'});
    expect(view.data).toEqual([{id: 'a', title: 'A'}]);

    // Optional fields can be set to null/undefined or left off completely.
    await createIssue({id: 'b'});
    expect(view.data).toEqual([
      {id: 'a', title: 'A'},
      {id: 'b', title: null},
    ]);

    await createIssue({id: 'c', title: undefined});
    expect(view.data).toEqual([
      {id: 'a', title: 'A'},
      {id: 'b', title: null},
      {id: 'c', title: null},
    ]);

    await createIssue({id: 'd', title: null});
    expect(view.data).toEqual([
      {id: 'a', title: 'A'},
      {id: 'b', title: null},
      {id: 'c', title: null},
      {id: 'd', title: null},
    ]);
  });

  test('set', async () => {
    const z = makeZero();

    const view = z.query.comment.materialize();
    await z.mutate.comment.insert({id: 'a', issueID: '1', text: 'A text'});
    expect(view.data).toEqual([{id: 'a', issueID: '1', text: 'A text'}]);

    const setComment = z.mutate.comment.upsert;
    await setComment({id: 'b', issueID: '2', text: 'B text'});
    expect(view.data).toEqual([
      {id: 'a', issueID: '1', text: 'A text'},
      {id: 'b', issueID: '2', text: 'B text'},
    ]);

    // set allows updating
    await setComment({id: 'a', issueID: '11', text: 'AA text'});
    expect(view.data).toEqual([
      {id: 'a', issueID: '11', text: 'AA text'},
      {id: 'b', issueID: '2', text: 'B text'},
    ]);

    // Optional fields can be set to null/undefined or left off completely.
    await setComment({id: 'c', issueID: '3'});
    expect(view.data[view.data.length - 1]).toEqual({
      id: 'c',
      issueID: '3',
      text: null,
    });

    await setComment({id: 'd', issueID: '4', text: undefined});
    expect(view.data[view.data.length - 1]).toEqual({
      id: 'd',
      issueID: '4',
      text: null,
    });

    await setComment({id: 'e', issueID: '5', text: undefined});
    expect(view.data[view.data.length - 1]).toEqual({
      id: 'e',
      issueID: '5',
      text: null,
    });

    // Setting with undefined/null/missing overwrites field to default/null.
    await setComment({id: 'a', issueID: '11'});
    expect(view.data[0]).toEqual({id: 'a', issueID: '11', text: null});

    await setComment({id: 'a', issueID: '11', text: 'foo'});
    expect(view.data[0]).toEqual({id: 'a', issueID: '11', text: 'foo'});

    await setComment({id: 'a', issueID: '11', text: undefined});
    expect(view.data[0]).toEqual({id: 'a', issueID: '11', text: null});

    await setComment({id: 'a', issueID: '11', text: 'foo'});
    expect(view.data[0]).toEqual({id: 'a', issueID: '11', text: 'foo'});
  });

  test('update', async () => {
    const z = makeZero();
    const view = z.query.comment.materialize();
    await z.mutate.comment.insert({id: 'a', issueID: '1', text: 'A text'});
    expect(view.data).toEqual([{id: 'a', issueID: '1', text: 'A text'}]);

    const updateComment = z.mutate.comment.update;
    await updateComment({id: 'a', issueID: '11', text: 'AA text'});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: 'AA text'}]);

    await updateComment({id: 'a', text: 'AAA text'});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: 'AAA text'}]);

    // update is a noop if not existing
    await updateComment({id: 'b', issueID: '2', text: 'B text'});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: 'AAA text'}]);

    // All fields take previous value if left off or set to undefined.
    await updateComment({id: 'a', issueID: '11'});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: 'AAA text'}]);

    await updateComment({id: 'a', issueID: '11', text: undefined});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: 'AAA text'}]);

    // 'optional' fields can be explicitly set to null to overwrite previous
    // value.
    await updateComment({id: 'a', issueID: '11', text: null});
    expect(view.data).toEqual([{id: 'a', issueID: '11', text: null}]);
  });

  test('compoundPK', async () => {
    const z = makeZero();
    const view = z.query.compoundPKTest.materialize();
    await z.mutate.compoundPKTest.insert({id1: 'a', id2: 'a', text: 'a'});
    expect(view.data).toEqual([{id1: 'a', id2: 'a', text: 'a'}]);

    await z.mutate.compoundPKTest.upsert({id1: 'a', id2: 'a', text: 'aa'});
    expect(view.data).toEqual([{id1: 'a', id2: 'a', text: 'aa'}]);

    await z.mutate.compoundPKTest.update({id1: 'a', id2: 'a', text: 'aaa'});
    expect(view.data).toEqual([{id1: 'a', id2: 'a', text: 'aaa'}]);

    await z.mutate.compoundPKTest.delete({id1: 'a', id2: 'a'});
    expect(view.data).toEqual([]);
  });

  test('do not expose _zero_crud', () => {
    const z = zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('issue')
            .columns({
              id: string(),
              title: string(),
            })
            .primaryKey('id'),
        ],
      }),
    });

    expect(
      (z.mutate as unknown as Record<string, unknown>)._zero_crud,
    ).toBeUndefined();
  });
});

suite('CRUD with compound primary key', () => {
  type Issue = {
    ids: string;
    idn: number;
    title: string;
  };
  type Comment = {
    ids: string;
    idn: number;
    issueIDs: string;
    issueIDn: number;
    text: string;
  };
  const makeZero = () =>
    zeroForTest({
      schema: createSchema(1, {
        tables: [
          table('issue')
            .columns({
              ids: string(),
              idn: number(),
              title: string(),
            })
            .primaryKey('idn', 'ids'),
          table('comment')
            .columns({
              ids: string(),
              idn: number(),
              issueIDs: string(),
              issueIDn: number(),
              text: string(),
            })
            .primaryKey('idn', 'ids'),
        ],
      }),
    });

  test('create', async () => {
    const z = makeZero();

    const createIssue: (issue: Issue) => Promise<void> = z.mutate.issue.insert;
    const view = z.query.issue.materialize();
    await createIssue({ids: 'a', idn: 1, title: 'A'});
    expect(view.data).toEqual([{ids: 'a', idn: 1, title: 'A'}]);

    // create again should not change anything
    await createIssue({ids: 'a', idn: 1, title: 'Again'});
    expect(view.data).toEqual([{ids: 'a', idn: 1, title: 'A'}]);
  });

  test('set', async () => {
    const z = makeZero();

    const view = z.query.comment.materialize();
    await z.mutate.comment.insert({
      ids: 'a',
      idn: 1,
      issueIDs: 'a',
      issueIDn: 1,
      text: 'A text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'a', issueIDn: 1, text: 'A text'},
    ]);

    const setComment: (comment: Comment) => Promise<void> =
      z.mutate.comment.upsert;
    await setComment({
      ids: 'b',
      idn: 2,
      issueIDs: 'b',
      issueIDn: 2,
      text: 'B text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'a', issueIDn: 1, text: 'A text'},
      {ids: 'b', idn: 2, issueIDs: 'b', issueIDn: 2, text: 'B text'},
    ]);

    // set allows updating
    await setComment({
      ids: 'a',
      idn: 1,
      issueIDs: 'aa',
      issueIDn: 11,
      text: 'AA text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'aa', issueIDn: 11, text: 'AA text'},
      {ids: 'b', idn: 2, issueIDs: 'b', issueIDn: 2, text: 'B text'},
    ]);
  });

  test('update', async () => {
    const z = makeZero();
    const view = z.query.comment.materialize();
    await z.mutate.comment.insert({
      ids: 'a',
      idn: 1,
      issueIDs: 'a',
      issueIDn: 1,
      text: 'A text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'a', issueIDn: 1, text: 'A text'},
    ]);

    const updateComment = z.mutate.comment.update;
    await updateComment({
      ids: 'a',
      idn: 1,
      issueIDs: 'aa',
      issueIDn: 11,
      text: 'AA text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'aa', issueIDn: 11, text: 'AA text'},
    ]);

    await updateComment({ids: 'a', idn: 1, text: 'AAA text'});
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'aa', issueIDn: 11, text: 'AAA text'},
    ]);

    // update is a noop if not existing
    await updateComment({
      ids: 'b',
      idn: 2,
      issueIDs: 'b',
      issueIDn: 2,
      text: 'B text',
    });
    expect(view.data).toEqual([
      {ids: 'a', idn: 1, issueIDs: 'aa', issueIDn: 11, text: 'AAA text'},
    ]);
  });
});

test('mutate is a function for batching', async () => {
  const z = zeroForTest({
    schema: createSchema(1, {
      tables: [
        table('issue')
          .columns({
            id: string(),
            title: string(),
          })
          .primaryKey('id'),
        table('comment')
          .columns({
            id: string(),
            issueID: string(),
            text: string(),
          })
          .primaryKey('id'),
      ],
    }),
  });
  const issueView = z.query.issue.materialize();
  const commentView = z.query.comment.materialize();

  const x = await z.mutateBatch(async m => {
    expect(
      (m as unknown as Record<string, unknown>)._zero_crud,
    ).toBeUndefined();
    await m.issue.insert({id: 'a', title: 'A'});
    await m.comment.insert({
      id: 'b',
      issueID: 'a',
      text: 'Comment for issue A',
    });
    await m.comment.update({
      id: 'b',
      text: 'Comment for issue A was changed',
    });
    return 123 as const;
  });

  expect(x).toBe(123);

  expect(issueView.data).toEqual([{id: 'a', title: 'A'}]);
  expect(commentView.data).toEqual([
    {id: 'b', issueID: 'a', text: 'Comment for issue A was changed'},
  ]);

  expect(
    (z.mutate as unknown as Record<string, unknown>)._zero_crud,
  ).toBeUndefined();
});

test('custom mutations get pushed', async () => {
  const schema = createSchema(1, {
    tables: [
      table('issues').columns({id: string(), value: number()}).primaryKey('id'),
    ],
  });
  const z = zeroForTest({
    schema,
    mutators: {
      issues: {
        foo: (tx, {foo}: {foo: number}) =>
          tx.mutate.issues.insert({id: foo.toString(), value: foo}),
      },
    },
  });
  await z.triggerConnected();
  const mockSocket = await z.socket;
  mockSocket.messages.length = 0;

  await Promise.all([
    z.mutate.issues.foo({foo: 42}),
    z.mutate.issues.foo({foo: 43}),
  ]);
  await z.mutate.issues.foo({foo: 44});
  await tickAFewTimes(clock, RUN_LOOP_INTERVAL_MS);

  expect(
    mockSocket.messages.map(x => {
      const ret = JSON.parse(x);
      if ('requestID' in ret[1]) {
        delete ret[1].requestID;
      }
      return ret;
    }),
  ).toEqual([
    [
      'push',
      {
        timestamp: 1678829450000,
        clientGroupID: await z.clientGroupID,
        mutations: [
          {
            type: 'custom',
            timestamp: 1678829450000,
            id: 1,
            clientID: z.clientID,
            name: 'issues.foo',
            args: [{foo: 42}],
          },
        ],
        pushVersion: 1,
        schemaVersion: 1,
      },
    ],
    [
      'push',
      {
        timestamp: 1678829450000,
        clientGroupID: await z.clientGroupID,
        mutations: [
          {
            type: 'custom',
            timestamp: 1678829450000,
            id: 2,
            clientID: z.clientID,
            name: 'issues.foo',
            args: [{foo: 43}],
          },
        ],
        pushVersion: 1,
        schemaVersion: 1,
      },
    ],
    [
      'push',
      {
        timestamp: 1678829450000,
        clientGroupID: await z.clientGroupID,
        mutations: [
          {
            type: 'custom',
            timestamp: 1678829450000,
            id: 3,
            clientID: z.clientID,
            name: 'issues.foo',
            args: [{foo: 44}],
          },
        ],
        pushVersion: 1,
        schemaVersion: 1,
      },
    ],
    ['ping', {}],
  ]);
});

test('calling mutate on the non batch version should throw inside a batch', async () => {
  const z = zeroForTest({
    schema: createSchema(1, {
      tables: [
        table('issue')
          .columns({
            id: string(),
            title: string(),
          })
          .primaryKey('id'),
        table('comment')
          .columns({
            id: string(),
            issueID: string(),
            text: string(),
          })
          .primaryKey('id'),
      ],
    }),
  });
  const commentView = z.query.comment.materialize();
  const issueView = z.query.issue.materialize();

  await expect(
    z.mutateBatch(async m => {
      await m.issue.insert({id: 'a', title: 'A'});
      await z.mutate.issue.insert({id: 'b', title: 'B'});
    }),
  ).rejects.toThrow('Cannot call mutate.issue.insert inside a batch');

  // make sure that we did not update the issue collection.
  expect(issueView.data).toEqual([]);

  await z.mutate.comment.insert({id: 'a', text: 'A', issueID: 'a'});
  expect(commentView.data).toEqual([{id: 'a', text: 'A', issueID: 'a'}]);

  await expect(
    z.mutateBatch(async () => {
      await z.mutate.comment.update({id: 'a', text: 'A2'});
    }),
  ).rejects.toThrow('Cannot call mutate.comment.update inside a batch');
  // make sure that we did not update the comment collection.
  expect(commentView.data).toEqual([{id: 'a', text: 'A', issueID: 'a'}]);

  await expect(
    z.mutateBatch(async () => {
      await z.mutate.comment.upsert({id: 'a', text: 'A2', issueID: 'a'});
    }),
  ).rejects.toThrow('Cannot call mutate.comment.upsert inside a batch');
  // make sure that we did not update the comment collection.
  expect(commentView.data).toEqual([{id: 'a', text: 'A', issueID: 'a'}]);

  await expect(
    z.mutateBatch(async () => {
      await z.mutate.comment.delete({id: 'a'});
    }),
  ).rejects.toThrow('Cannot call mutate.comment.delete inside a batch');
  // make sure that we did not delete the comment row
  expect(commentView.data).toEqual([{id: 'a', text: 'A', issueID: 'a'}]);

  await expect(
    z.mutateBatch(async () => {
      await z.mutateBatch(() => {});
    }),
  ).rejects.toThrow('Cannot call mutate inside a batch');
});
