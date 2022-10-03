import type {LogContext} from '@rocicorp/logger';
import type * as dag from '../dag/mod';
import * as db from '../db/mod';
import type {JSONValue, ReadonlyJSONValue} from '../json';
import {
  assertPullResponseSDD,
  assertPullResponseDD31,
  isClientStateNotFoundResponse,
  Puller,
  PullerDD31,
  PullerResult,
  PullerResultDD31,
  PullError,
  PullResponse,
  PullResponseDD31,
  PullResponseOK,
  PullResponseOKDD31,
} from '../puller';
import {assertHTTPRequestInfo, HTTPRequestInfo} from '../http-request-info';
import {callJSRequest} from './js-request';
import {SYNC_HEAD_NAME} from './sync-head-name';
import * as patch from './patch';
import {toError} from '../to-error';
import * as btree from '../btree/mod';
import {BTreeRead} from '../btree/mod';
import {updateIndexes} from '../db/write';
import {emptyHash, Hash} from '../hash';
import {
  toInternalValue,
  InternalValue,
  ToInternalValueReason,
  deepEqual,
  FromInternalValueReason,
  fromInternalValue,
} from '../internal-value';
import type {BranchID, ClientID} from './ids';
import {addDiffsForIndexes, DiffComputationConfig, DiffsMap} from './diff';
import {assert, assertObject} from '../asserts.js';
import {
  assertLocalCommitDD31,
  assertLocalMetaDD31,
  assertSnapshotMetaDD31,
} from '../db/commit.js';
import {assertClientDD31, getClients} from '../persist/clients.js';
import * as json from '../json';

export const PULL_VERSION_SDD = 0;
export const PULL_VERSION_DD31 = 1;

/**
 * The JSON value used as the body when doing a POST to the [pull
 * endpoint](/server-pull).
 */
export type PullRequest<Cookie = ReadonlyJSONValue> = {
  profileID: string;
  clientID: ClientID;
  cookie: Cookie;
  lastMutationID: number;
  pullVersion: typeof PULL_VERSION_SDD;
  // schemaVersion can optionally be used by the customer's app
  // to indicate to the data layer what format of Client View the
  // app understands.
  schemaVersion: string;
};

/**
 * The JSON value used as the body when doing a POST to the [pull
 * endpoint](/server-pull).
 */
export type PullRequestDD31<Cookie = ReadonlyJSONValue> = {
  profileID: string;
  clientID: ClientID;
  // TODO(DD31): Rename to clientGroupID
  branchID: BranchID;
  cookie: Cookie;
  // TODO(DD31): Rename to isNewClientGroup
  isNewBranch: boolean;
  pullVersion: typeof PULL_VERSION_DD31;
  // schemaVersion can optionally be used by the customer's app
  // to indicate to the data layer what format of Client View the
  // app understands.
  schemaVersion: string;
};

export type BeginPullRequest = {
  pullURL: string;
  pullAuth: string;
  schemaVersion: string;
};

export type BeginPullRequestDD31 = {
  pullURL: string;
  pullAuth: string;
  schemaVersion: string;
};

export type BeginPullResponse = {
  httpRequestInfo: HTTPRequestInfo;
  pullResponse?: PullResponse;
  syncHead: Hash;
};

export type BeginPullResponseDD31 = {
  httpRequestInfo: HTTPRequestInfo;
  pullResponse?: PullResponseDD31;
  syncHead: Hash;
};

export async function beginPull(
  profileID: string,
  clientID: ClientID,
  branchID: BranchID | undefined,
  beginPullReq: BeginPullRequest | BeginPullRequestDD31,
  puller: Puller | PullerDD31,
  requestID: string,
  store: dag.Store,
  lc: LogContext,
  createSyncBranch = true,
): Promise<BeginPullResponse | BeginPullResponseDD31> {
  if (DD31) {
    assert(branchID);
    return beginPullDD31(
      profileID,
      clientID,
      branchID,
      beginPullReq as BeginPullRequestDD31,
      puller as PullerDD31,
      requestID,
      store,
      lc,
      createSyncBranch,
    );
  }
  return beginPullSDD(
    profileID,
    clientID,
    beginPullReq as BeginPullRequest,
    puller as Puller,
    requestID,
    store,
    lc,
    createSyncBranch,
  );
}

export async function beginPullSDD(
  profileID: string,
  clientID: ClientID,
  beginPullReq: BeginPullRequest,
  puller: Puller,
  requestID: string,
  store: dag.Store,
  lc: LogContext,
  createSyncBranch = true,
): Promise<BeginPullResponse> {
  assert(!DD31);
  const {pullURL, pullAuth, schemaVersion} = beginPullReq;

  const [lastMutationID, baseCookie] = await store.withRead(async dagRead => {
    const mainHeadHash = await dagRead.getHead(db.DEFAULT_HEAD_NAME);
    if (!mainHeadHash) {
      throw new Error('Internal no main head found');
    }
    const baseSnapshot = await db.baseSnapshotFromHash(mainHeadHash, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    const baseCookie = baseSnapshotMeta.cookieJSON;
    const lastMutationID = await baseSnapshot.getMutationID(clientID, dagRead);
    return [lastMutationID, baseCookie];
  });

  const pullReq: PullRequest<JSONValue> = {
    profileID,
    clientID,
    cookie: fromInternalValue(
      baseCookie,
      FromInternalValueReason.PullSendCookie,
    ),
    lastMutationID,
    pullVersion: PULL_VERSION_SDD,
    schemaVersion,
  };
  lc.debug?.('Starting pull...');
  const pullStart = Date.now();
  const {response, httpRequestInfo} = await callPuller(
    puller,
    pullURL,
    pullReq,
    pullAuth,
    requestID,
  );

  lc.debug?.(
    `...Pull ${response ? 'complete' : 'failed'} in `,
    Date.now() - pullStart,
    'ms',
  );

  // If Puller did not get a pull response we still want to return the HTTP
  // request info to the JS SDK.
  if (!response) {
    return {
      httpRequestInfo,
      syncHead: emptyHash,
    };
  }

  if (!createSyncBranch || isClientStateNotFoundResponse(response)) {
    return {
      httpRequestInfo,
      pullResponse: response,
      syncHead: emptyHash,
    };
  }

  const syncHead = await handlePullResponseSDD(
    lc,
    store,
    baseCookie,
    response,
    clientID,
  );
  if (syncHead === null) {
    throw new Error('Overlapping sync JsLogInfo');
  }
  return {
    httpRequestInfo,
    pullResponse: response,
    syncHead,
  };
}

export async function beginPullDD31(
  profileID: string,
  clientID: ClientID,
  branchID: BranchID,
  beginPullReq: BeginPullRequestDD31,
  puller: PullerDD31,
  requestID: string,
  store: dag.Store,
  lc: LogContext,
  createSyncBranch = true,
): Promise<BeginPullResponseDD31> {
  assert(DD31);
  assert(branchID);
  const {pullURL, pullAuth, schemaVersion} = beginPullReq;

  const [lastMutationIDs, baseCookie, isNewBranch] = await store.withRead(
    async dagRead => {
      const mainHeadHash = await dagRead.getHead(db.DEFAULT_HEAD_NAME);
      if (!mainHeadHash) {
        throw new Error('Internal no main head found');
      }
      const baseSnapshot = await db.baseSnapshotFromHash(mainHeadHash, dagRead);
      const baseSnapshotMeta = baseSnapshot.meta;
      const baseCookie = baseSnapshotMeta.cookieJSON;
      assertSnapshotMetaDD31(baseSnapshotMeta);
      const isNewBranch =
        Object.keys(baseSnapshotMeta.lastMutationIDs).length === 0;

      const lastMutationIDs = await lastMutationIDsForSnapshotMeta(
        baseSnapshotMeta,
        dagRead,
        branchID,
      );

      // Add `[clientID]: 0` for mutation commits on top of the snapshot that
      // are not already in the snapshot.
      const localMutations = await db.localMutations(mainHeadHash, dagRead);
      for (const {meta} of localMutations) {
        assertLocalMetaDD31(meta);
        const {clientID} = meta;
        if (lastMutationIDs[clientID] === undefined) {
          lastMutationIDs[clientID] = 0;
        }
      }

      return [lastMutationIDs, baseCookie, isNewBranch];
    },
  );

  const pullReq: PullRequestDD31<ReadonlyJSONValue> = {
    profileID,
    clientID,
    branchID,
    cookie: fromInternalValue(
      baseCookie,
      FromInternalValueReason.PullSendCookie,
    ),
    pullVersion: PULL_VERSION_DD31,
    schemaVersion,
    isNewBranch,
  };
  lc.debug?.('Starting pull...');
  const pullStart = Date.now();
  const {response, httpRequestInfo} = await callPullerDD31(
    puller as PullerDD31,
    pullURL,
    pullReq,
    pullAuth,
    requestID,
  );
  lc.debug?.(
    `...Pull ${response ? 'complete' : 'failed'} in `,
    Date.now() - pullStart,
    'ms',
  );

  // If Puller did not get a pull response we still want to return the HTTP
  // request info to the JS SDK.
  if (!response) {
    return {
      httpRequestInfo,
      syncHead: emptyHash,
    };
  }

  if (!createSyncBranch || isClientStateNotFoundResponse(response)) {
    return {
      httpRequestInfo,
      pullResponse: response,
      syncHead: emptyHash,
    };
  }

  const syncHead = await handlePullResponseDD31(
    lc,
    store,
    baseCookie,
    lastMutationIDs,
    response,
    clientID,
  );
  if (syncHead === null) {
    throw new Error('Overlapping sync JsLogInfo');
  }
  return {
    httpRequestInfo,
    pullResponse: response,
    syncHead,
  };
}

/**
 * Gets the base snapshot from the branch named by headName and returns the last
 * mutation IDs. This does not include mutation commits on top of the base snapshot.
 */
export function lastMutationIDsForSnapshotFromHead(
  headName: string,
  dagStore: dag.Store,
  branchID: string,
) {
  return dagStore.withRead(async dagRead => {
    const mainHeadHash = await dagRead.getHead(headName);
    if (!mainHeadHash) {
      throw new Error('Internal no main head found');
    }
    const baseSnapshot = await db.baseSnapshotFromHash(mainHeadHash, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    assertSnapshotMetaDD31(baseSnapshotMeta);
    return lastMutationIDsForSnapshotMeta(baseSnapshotMeta, dagRead, branchID);
  });
}

async function lastMutationIDsForSnapshotMeta(
  baseSnapshotMeta: db.SnapshotMetaDD31,
  dagRead: dag.Read,
  branchID: BranchID,
) {
  const lastMutationIDs = {
    ...baseSnapshotMeta.lastMutationIDs,
  };
  const clients = await getClients(dagRead);
  for (const [clientID, client] of clients) {
    assertClientDD31(client);
    if (
      client.branchID === branchID &&
      lastMutationIDs[clientID] === undefined
    ) {
      lastMutationIDs[clientID] = 0;
    }
  }
  return lastMutationIDs;
}

// Returns new sync head, or null if response did not apply due to mismatched cookie.
export async function handlePullResponseSDD(
  lc: LogContext,
  store: dag.Store,
  expectedBaseCookie: InternalValue,
  response: PullResponseOK,
  clientID: ClientID,
): Promise<Hash | null> {
  // It is possible that another sync completed while we were pulling. Ensure
  // that is not the case by re-checking the base snapshot.
  return await store.withWrite(async dagWrite => {
    const dagRead = dagWrite;
    const mainHead = await dagRead.getHead(db.DEFAULT_HEAD_NAME);

    if (mainHead === undefined) {
      throw new Error('Main head disappeared');
    }
    const baseSnapshot = await db.baseSnapshotFromHash(mainHead, dagRead);
    const [baseLastMutationID, baseCookie] = db.snapshotMetaParts(
      baseSnapshot,
      clientID,
    );

    // TODO(MP) Here we are using whether the cookie has changes as a proxy for whether
    // the base snapshot changed, which is the check we used to do. I don't think this
    // is quite right. We need to firm up under what conditions we will/not accept an
    // update from the server: https://github.com/rocicorp/replicache/issues/713.
    if (!deepEqual(expectedBaseCookie, baseCookie)) {
      return null;
    }

    // If other entities (eg, other clients) are modifying the client view
    // the client view can change but the lastMutationID stays the same.
    // So be careful here to reject only a lesser lastMutationID.
    if (response.lastMutationID < baseLastMutationID) {
      throw new Error(
        `Received lastMutationID ${response.lastMutationID} is < than last snapshot lastMutationID ${baseLastMutationID}; ignoring client view`,
      );
    }

    const internalCookie = toInternalValue(
      response.cookie ?? null,
      ToInternalValueReason.CookieFromResponse,
    );

    // If there is no patch and the lmid and cookie don't change, it's a nop.
    // Otherwise, we will write a new commit, including for the case of just
    // a cookie change.
    if (
      response.patch.length === 0 &&
      response.lastMutationID === baseLastMutationID &&
      deepEqual(internalCookie, baseCookie)
    ) {
      return emptyHash;
    }

    // We are going to need to adjust the indexes. Imagine we have just pulled:
    //
    // S1 - M1 - main
    //    \ S2 - sync
    //
    // Let's say S2 says that it contains up to M1. Are we safe at this moment
    // to set main to S2?
    //
    // No, because the Replicache protocol does not require a snapshot
    // containing M1 to have the same data as the client computed for M1!
    //
    // We must diff the main map in M1 against the main map in S2 and see if it
    // contains any changes. Whatever changes it contains must be applied to
    // all indexes.
    //
    // We start with the index definitions in the last commit that was
    // integrated into the new snapshot.
    const chain = await db.commitChain(mainHead, dagRead);
    let lastIntegrated: db.Commit<db.Meta> | undefined;
    for (const commit of chain) {
      if (
        (await commit.getMutationID(clientID, dagRead)) <=
        response.lastMutationID
      ) {
        lastIntegrated = commit;
        break;
      }
    }

    if (!lastIntegrated) {
      throw new Error('Internal invalid chain');
    }

    const dbWrite = await db.newWriteSnapshot(
      db.whenceHash(baseSnapshot.chunk.hash),
      response.lastMutationID,
      internalCookie,
      dagWrite,
      db.readIndexesForWrite(lastIntegrated, dagWrite),
      clientID,
    );

    await patch.apply(lc, dbWrite, response.patch);

    const lastIntegratedMap = new BTreeRead(dagRead, lastIntegrated.valueHash);

    for await (const change of dbWrite.map.diff(lastIntegratedMap)) {
      await updateIndexes(
        lc,
        dbWrite.indexes,
        change.key,
        () =>
          Promise.resolve(
            (change as {oldValue: InternalValue | undefined}).oldValue,
          ),
        (change as {newValue: InternalValue | undefined}).newValue,
      );
    }

    return await dbWrite.commit(SYNC_HEAD_NAME);
  });
}

export async function handlePullResponseDD31(
  lc: LogContext,
  store: dag.Store,
  expectedBaseCookie: InternalValue,
  requestLastMutationIDs: Record<ClientID, number>,
  response: PullResponseOKDD31,
  clientID: ClientID,
): Promise<Hash | null> {
  // It is possible that another sync completed while we were pulling. Ensure
  // that is not the case by re-checking the base snapshot.
  return await store.withWrite(async dagWrite => {
    const dagRead = dagWrite;
    const mainHead = await dagRead.getHead(db.DEFAULT_HEAD_NAME);
    if (mainHead === undefined) {
      throw new Error('Main head disappeared');
    }
    const baseSnapshot = await db.baseSnapshotFromHash(mainHead, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    assertSnapshotMetaDD31(baseSnapshotMeta);
    const baseCookie = baseSnapshotMeta.cookieJSON;

    // TODO(MP) Here we are using whether the cookie has changes as a proxy for whether
    // the base snapshot changed, which is the check we used to do. I don't think this
    // is quite right. We need to firm up under what conditions we will/not accept an
    // update from the server: https://github.com/rocicorp/replicache/issues/713.
    if (!deepEqual(expectedBaseCookie, baseCookie)) {
      lc.debug?.('handlePullResponse: cookie mismatch');
      return null;
    }

    // If other entities (eg, other clients) are modifying the client view
    // the client view can change but the lastMutationID stays the same.
    // So be careful here to reject only a lesser lastMutationID.
    for (const [clientID, lastMutationID] of Object.entries(
      requestLastMutationIDs,
    )) {
      const responseLastMutationID = response.lastMutationIDChanges[clientID];
      if (responseLastMutationID === undefined) {
        throw new Error(`Missing lastMutationID change for client ${clientID}`);
      }
      if (responseLastMutationID < lastMutationID) {
        lc.debug?.(
          'responseLastMutationID not larger than lastMutationID',
          'responseLastMutationID',
          responseLastMutationID,
          'lastMutationID',
          lastMutationID,
        );
        throw new Error(
          `Received lastMutationID ${responseLastMutationID} is < than last snapshot lastMutationID ${lastMutationID}; ignoring client view`,
        );
      }
    }

    const internalCookie = toInternalValue(
      response.cookie,
      ToInternalValueReason.CookieFromResponse,
    );

    // If there is no patch and the lmid and cookie don't change, it's a nop.
    // Otherwise, we will write a new commit, including for the case of just
    // a cookie change.
    if (
      response.patch.length === 0 &&
      json.deepEqual(requestLastMutationIDs, response.lastMutationIDChanges) &&
      deepEqual(internalCookie, baseCookie)
    ) {
      return emptyHash;
    }

    // Indexes need to be created for the new snapshot. To create, start
    // with the indexes of the the main head commit, then
    // diff the value map of the main head commit against the value map of
    // the new snapshot, and apply changes to the indexes.
    // Note: with this approach we won't lose any indexes, however
    // rebased mutations may see indexes which did not exist when
    // they were first executed.
    const mainHeadCommit = await db.commitFromHash(mainHead, dagRead);
    const dbWrite = await db.newWriteSnapshotDD31(
      db.whenceHash(baseSnapshot.chunk.hash),
      response.lastMutationIDChanges,
      internalCookie,
      dagWrite,
      db.readIndexesForWrite(mainHeadCommit, dagWrite),
      clientID,
    );

    await patch.apply(lc, dbWrite, response.patch);

    const mainHeadMap = new BTreeRead(dagRead, mainHeadCommit.valueHash);

    // No need to diff here if we have no indexes.
    if (dbWrite.indexes.size > 0) {
      for await (const change of dbWrite.map.diff(mainHeadMap)) {
        await updateIndexes(
          lc,
          dbWrite.indexes,
          change.key,
          () =>
            Promise.resolve(
              (change as {oldValue: InternalValue | undefined}).oldValue,
            ),
          (change as {newValue: InternalValue | undefined}).newValue,
        );
      }
    }

    return await dbWrite.commit(SYNC_HEAD_NAME);
  });
}

export type MaybeEndPullResultSDD = {
  replayMutations?: db.Commit<db.LocalMetaSDD>[];
  syncHead: Hash;
  diffs: DiffsMap;
};

export type MaybeEndPullResultDD31 = {
  replayMutations?: db.Commit<db.LocalMetaDD31>[];
  syncHead: Hash;
  diffs: DiffsMap;
};

export async function maybeEndPull(
  store: dag.Store,
  lc: LogContext,
  expectedSyncHead: Hash,
  clientID: ClientID,
  diffConfig: DiffComputationConfig,
): Promise<MaybeEndPullResultDD31 | MaybeEndPullResultSDD> {
  // Ensure sync head is what the caller thinks it is.
  return await store.withWrite(async dagWrite => {
    const dagRead = dagWrite;
    const syncHeadHash = await dagRead.getHead(SYNC_HEAD_NAME);
    if (syncHeadHash === undefined) {
      throw new Error('Missing sync head');
    }
    if (syncHeadHash !== expectedSyncHead) {
      lc.error?.(
        'maybeEndPull, Wrong sync head. Expecting:',
        expectedSyncHead,
        'got:',
        syncHeadHash,
      );
      throw new Error('Wrong sync head');
    }

    // Ensure another sync has not landed a new snapshot on the main chain.
    const syncSnapshot = await db.baseSnapshotFromHash(syncHeadHash, dagRead);
    const mainHeadHash = await dagRead.getHead(db.DEFAULT_HEAD_NAME);
    if (mainHeadHash === undefined) {
      throw new Error('Missing main head');
    }
    const mainSnapshot = await db.baseSnapshotFromHash(mainHeadHash, dagRead);

    const {meta} = syncSnapshot;
    const syncSnapshotBasis = meta.basisHash;
    if (syncSnapshot === null) {
      throw new Error('Sync snapshot with no basis');
    }
    if (syncSnapshotBasis !== mainSnapshot.chunk.hash) {
      throw new Error('Overlapping syncs');
    }

    // Collect pending commits from the main chain and determine which
    // of them if any need to be replayed.
    const syncHead = await db.commitFromHash(syncHeadHash, dagRead);
    const pending: db.Commit<db.LocalMetaDD31 | db.LocalMetaSDD>[] = [];
    const localMutations = await db.localMutations(mainHeadHash, dagRead);
    for (const commit of localMutations) {
      let cid = clientID;
      if (DD31) {
        assertLocalCommitDD31(commit);
        cid = commit.meta.clientID;
      }
      if (
        (await commit.getMutationID(cid, dagRead)) >
        (await syncHead.getMutationID(cid, dagRead))
      ) {
        pending.push(commit);
      }
    }
    // pending() gave us the pending mutations in sync-head-first order whereas
    // caller wants them in the order to replay (lower mutation ids first).
    pending.reverse();

    // We return the keys that changed due to this pull. This is used by
    // subscriptions in the JS API when there are no more pending mutations.
    const diffsMap = new DiffsMap();

    // Return replay commits if any.
    if (pending.length > 0) {
      return {
        syncHead: syncHeadHash,
        replayMutations: pending,
        // The changed keys are not reported when further replays are
        // needed. The diffs will be reported at the end when there
        // are no more mutations to be replay and then it will be reported
        // relative to DEFAULT_HEAD_NAME.
        diffs: diffsMap,
      };
    }

    // TODO check invariants

    // Compute diffs (changed keys) for value map and index maps.
    const mainHead = await db.commitFromHash(mainHeadHash, dagRead);
    if (diffConfig.shouldComputeDiffs()) {
      const mainHeadMap = new BTreeRead(dagRead, mainHead.valueHash);
      const syncHeadMap = new BTreeRead(dagRead, syncHead.valueHash);
      const valueDiff = await btree.diff(mainHeadMap, syncHeadMap);
      diffsMap.set('', valueDiff);
      await addDiffsForIndexes(
        mainHead,
        syncHead,
        dagRead,
        diffsMap,
        diffConfig,
      );
    }

    // No mutations to replay so set the main head to the sync head and sync complete!
    await Promise.all([
      dagWrite.setHead(db.DEFAULT_HEAD_NAME, syncHeadHash),
      dagWrite.removeHead(SYNC_HEAD_NAME),
    ]);
    await dagWrite.commit();

    if (lc.debug) {
      const [oldLastMutationID, oldCookie] = db.snapshotMetaParts(
        mainSnapshot,
        clientID,
      );
      const [newLastMutationID, newCookie] = db.snapshotMetaParts(
        syncSnapshot,
        clientID,
      );
      lc.debug(
        `Successfully pulled new snapshot w/last_mutation_id:`,
        newLastMutationID,
        `(prev:`,
        oldLastMutationID,
        `), cookie: `,
        newCookie,
        `(prev:`,
        oldCookie,
        `), sync head hash:`,
        syncHeadHash,
        ', main head hash:',
        mainHeadHash,
        `, value_hash:`,
        syncHead.valueHash,
        `(prev:`,
        mainSnapshot.valueHash,
      );
    }

    return {
      syncHead: syncHeadHash,
      replayMutations: [],
      diffs: diffsMap,
    };
  });
}

async function callPuller(
  puller: Puller,
  url: string,
  body: PullRequest<ReadonlyJSONValue>,
  auth: string,
  requestID: string,
): Promise<PullerResult> {
  try {
    const res = await callJSRequest(puller, url, body, auth, requestID);
    assertResult(res);
    return res;
  } catch (e) {
    throw new PullError(toError(e));
  }
}

async function callPullerDD31(
  puller: PullerDD31,
  url: string,
  body: PullRequestDD31<ReadonlyJSONValue>,
  auth: string,
  requestID: string,
): Promise<PullerResultDD31> {
  try {
    const res = await callJSRequest(puller, url, body, auth, requestID);
    assertResultDD31(res);
    return res;
  } catch (e) {
    throw new PullError(toError(e));
  }
}

type Result = {
  response?: PullResponse;
  httpRequestInfo: HTTPRequestInfo;
};

type ResultDD31 = {
  response?: PullResponseDD31;
  httpRequestInfo: HTTPRequestInfo;
};

function assertResultBase(v: unknown): asserts v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) {
    throw new Error('Expected result to be an object');
  }
  assertObject(v);
  assertHTTPRequestInfo(v.httpRequestInfo);
}

function assertResult(v: unknown): asserts v is Result {
  assertResultBase(v);
  if (v.response !== undefined) {
    assertPullResponseSDD(v.response);
  }
}

function assertResultDD31(v: unknown): asserts v is ResultDD31 {
  assertResultBase(v);
  if (v.response !== undefined) {
    assertPullResponseDD31(v.response);
  }
}
