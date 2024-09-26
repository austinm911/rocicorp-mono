import {
  getLicenseStatus,
  licenseActive,
  LicenseStatus,
  PROD_LICENSE_SERVER_URL,
  TEST_LICENSE_KEY,
} from '@rocicorp/licensing/out/client';
import {consoleLogSink, LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {AbortError} from 'shared/src/abort-error.js';
import {assert} from 'shared/src/asserts.js';
import {getDocument} from 'shared/src/browser-env.js';
import {getDocumentVisibilityWatcher} from 'shared/src/document-visible.js';
import type {JSONValue, ReadonlyJSONValue} from 'shared/src/json.js';
import type {MaybePromise} from 'shared/src/types.js';
import {initBgIntervalProcess} from './bg-interval.js';
import {PullDelegate, PushDelegate} from './connection-loop-delegates.js';
import {ConnectionLoop, MAX_DELAY_MS, MIN_DELAY_MS} from './connection-loop.js';
import {assertCookie, type Cookie} from './cookies.js';
import {LazyStore} from './dag/lazy-store.js';
import {StoreImpl} from './dag/store-impl.js';
import {ChunkNotFoundError, mustGetHeadHash, type Store} from './dag/store.js';
import {
  baseSnapshotFromHash,
  DEFAULT_HEAD_NAME,
  isLocalMetaDD31,
  type LocalMeta,
} from './db/commit.js';
import {readFromDefaultHead} from './db/read.js';
import {rebaseMutationAndCommit} from './db/rebase.js';
import {newWriteLocal} from './db/write.js';
import {
  isClientStateNotFoundResponse,
  isVersionNotSupportedResponse,
  type VersionNotSupportedResponse,
} from './error-responses.js';
import {FormatVersion} from './format-version.js';
import {deepFreeze} from './frozen-json.js';
import {getDefaultPuller, isDefaultPuller} from './get-default-puller.js';
import {getDefaultPusher, isDefaultPusher} from './get-default-pusher.js';
import {assertHash, emptyHash, type Hash, newRandomHash} from './hash.js';
import type {HTTPRequestInfo} from './http-request-info.js';
import type {IndexDefinitions} from './index-defs.js';
import type {StoreProvider} from './kv/store.js';
import {createLogContext} from './log-options.js';
import {MutationRecovery} from './mutation-recovery.js';
import {initNewClientChannel} from './new-client-channel.js';
import {
  initOnPersistChannel,
  type OnPersist,
  type PersistInfo,
} from './on-persist-channel.js';
import {
  type PendingMutation,
  pendingMutationsForAPI,
} from './pending-mutations.js';
import {
  CLIENT_MAX_INACTIVE_TIME,
  GC_INTERVAL,
  initClientGC,
} from './persist/client-gc.js';
import {initClientGroupGC} from './persist/client-group-gc.js';
import {disableClientGroup} from './persist/client-groups.js';
import {
  type ClientMap,
  ClientStateNotFoundError,
  initClientV6,
  hasClientState as persistHasClientState,
} from './persist/clients.js';
import {
  COLLECT_IDB_INTERVAL,
  initCollectIDBDatabases,
  INITIAL_COLLECT_IDB_DELAY,
  SDD_IDB_MAX_AGE,
} from './persist/collect-idb-databases.js';
import {HEARTBEAT_INTERVAL, startHeartbeats} from './persist/heartbeat.js';
import {
  IDBDatabasesStore,
  type IndexedDBDatabase,
} from './persist/idb-databases-store.js';
import {makeClientID} from './persist/make-client-id.js';
import {persistDD31} from './persist/persist.js';
import {refresh} from './persist/refresh.js';
import {ProcessScheduler} from './process-scheduler.js';
import type {Puller} from './puller.js';
import {type Pusher, PushError} from './pusher.js';
import type {ReplicacheOptions} from './replicache-options.js';
import {
  getKVStoreProvider,
  httpStatusUnauthorized,
  makeIDBName,
  ReportError,
} from './replicache.js';
import {setIntervalWithSignal} from './set-interval-with-signal.js';
import {mustSimpleFetch} from './simple-fetch.js';
import {
  type SubscribeOptions,
  SubscriptionImpl,
  type SubscriptionsManager,
  SubscriptionsManagerImpl,
  type WatchCallback,
  type WatchCallbackForOptions,
  type WatchNoIndexCallback,
  type WatchOptions,
  WatchSubscription,
} from './subscriptions.js';
import type {ClientGroupID, ClientID} from './sync/ids.js';
import {PullError} from './sync/pull-error.js';
import {
  beginPullV1,
  HandlePullResponseResultType,
  handlePullResponseV1,
  maybeEndPull,
} from './sync/pull.js';
import {push, PUSH_VERSION_DD31} from './sync/push.js';
import {newRequestID} from './sync/request-id.js';
import {SYNC_HEAD_NAME} from './sync/sync-head-name.js';
import {throwIfClosed} from './transaction-closed-error.js';
import type {ReadTransaction, WriteTransaction} from './transactions.js';
import {ReadTransactionImpl, WriteTransactionImpl} from './transactions.js';
import type {
  BeginPullResult,
  MakeMutator,
  MakeMutators,
  MutatorDefs,
  MutatorReturn,
  PokeInternal,
  QueryInternal,
  RequestOptions,
  UpdateNeededReason,
} from './types.js';
import {version} from './version.js';
import {
  withRead,
  withWrite,
  withWriteNoImplicitCommit,
} from './with-transactions.js';

declare const TESTING: boolean;

/**
 * The maximum number of time to call out to getAuth before giving up
 * and throwing an error.
 */
const MAX_REAUTH_TRIES = 8;

const PERSIST_IDLE_TIMEOUT_MS = 1000;
const REFRESH_IDLE_TIMEOUT_MS = 1000;

const PERSIST_THROTTLE_MS = 500;
const REFRESH_THROTTLE_MS = 500;

const LAZY_STORE_SOURCE_CHUNK_CACHE_SIZE_LIMIT = 100 * 2 ** 20; // 100 MB

const RECOVER_MUTATIONS_INTERVAL_MS = 5 * 60 * 1000; // 5 mins
const LICENSE_ACTIVE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TEST_LICENSE_KEY_TTL_MS = 5 * 60 * 1000;

const noop = () => {
  // noop
};

const updateNeededReasonNewClientGroup: UpdateNeededReason = {
  type: 'NewClientGroup',
} as const;

export interface MakeSubscriptionsManager {
  (queryInternal: QueryInternal, lc: LogContext): SubscriptionsManager;
}

const defaultMakeSubscriptionsManager: MakeSubscriptionsManager = (
  queryInternal,
  lc,
) => new SubscriptionsManagerImpl(queryInternal, lc);

export interface ReplicacheImplOptions {
  /**
   * Defaults to true.
   * Does not use a symbol because it is used by reflect.
   */
  enableLicensing?: boolean | undefined;

  /**
   * Defaults to true.
   */
  enableMutationRecovery?: boolean | undefined;

  /**
   * Defaults to true.
   */
  enableScheduledPersist?: boolean | undefined;

  /**
   * Defaults to true.
   */
  enableScheduledRefresh?: boolean | undefined;

  /**
   * Defaults to true.
   */
  enablePullAndPushInOpen?: boolean | undefined;

  /**
   * Default is `defaultMakeSubscriptionsManager`.
   */
  makeSubscriptionsManager?: MakeSubscriptionsManager | undefined;

  /**
   * Default is `true`.  If `false` if an exact match client group
   * is not found, a new client group is always made instead of forking
   * from an existing client group.
   */
  enableClientGroupForking?: boolean | undefined;
}

// eslint-disable-next-line @typescript-eslint/ban-types
export class ReplicacheImpl<MD extends MutatorDefs = {}> {
  /** The URL to use when doing a pull request. */
  pullURL: string;

  /** The URL to use when doing a push request. */
  pushURL: string;

  /** The authorization token used when doing a push request. */
  auth: string;

  /** The name of the Replicache database. Populated by {@link ReplicacheOptions#name}. */
  readonly name: string;

  readonly subscriptions: SubscriptionsManager;
  readonly #mutationRecovery: MutationRecovery;

  /**
   * Client groups gets disabled when the server does not know about it.
   * A disabled client group prevents the client from pushing and pulling.
   */
  isClientGroupDisabled = false;

  readonly #kvStoreProvider: StoreProvider;

  lastMutationID: number = 0;

  /**
   * This is the name Replicache uses for the IndexedDB database where data is
   * stored.
   */
  get idbName(): string {
    return makeIDBName(this.name, this.schemaVersion);
  }

  /** The schema version of the data understood by this application. */
  readonly schemaVersion: string;

  get #idbDatabase(): IndexedDBDatabase {
    return {
      name: this.idbName,
      replicacheName: this.name,
      replicacheFormatVersion: FormatVersion.Latest,
      schemaVersion: this.schemaVersion,
    };
  }
  #closed = false;
  #online = true;
  readonly #clientID = makeClientID();
  readonly #ready: Promise<void>;
  readonly #profileIDPromise: Promise<string>;
  readonly #clientGroupIDPromise: Promise<string>;
  readonly licenseCheckPromise: Promise<boolean>;

  /* The license is active if we have sent at least one license active ping
   * (and we will continue to). We do not send license active pings when
   * for the TEST_LICENSE_KEY.
   */
  readonly licenseActivePromise: Promise<boolean>;
  #testLicenseKeyTimeout: ReturnType<typeof setTimeout> | null = null;
  readonly #mutatorRegistry: MutatorDefs = {};

  /**
   * The mutators that was registered in the constructor.
   */
  readonly mutate: MakeMutators<MD>;

  // Number of pushes/pulls at the moment.
  #pushCounter = 0;
  #pullCounter = 0;

  #pullConnectionLoop: ConnectionLoop;
  #pushConnectionLoop: ConnectionLoop;

  /**
   * The duration between each periodic {@link pull}. Setting this to `null`
   * disables periodic pull completely. Pull will still happen if you call
   * {@link pull} manually.
   */
  pullInterval: number | null;

  /**
   * The delay between when a change is made to Replicache and when Replicache
   * attempts to push that change.
   */
  pushDelay: number;

  readonly #requestOptions: Required<RequestOptions>;

  /**
   * The function to use to pull data from the server.
   */
  puller: Puller;

  /**
   * The function to use to push data to the server.
   */
  pusher: Pusher;

  readonly #licenseKey: string | undefined;

  readonly memdag: LazyStore;
  readonly perdag: Store;
  readonly #idbDatabases: IDBDatabasesStore;
  readonly #lc: LogContext;

  readonly #closeAbortController = new AbortController();

  #persistIsRunning = false;
  readonly #enableScheduledPersist: boolean;
  readonly #enableScheduledRefresh: boolean;
  readonly #enablePullAndPushInOpen: boolean;
  #persistScheduler = new ProcessScheduler(
    () => this.persist(),
    PERSIST_IDLE_TIMEOUT_MS,
    PERSIST_THROTTLE_MS,
    this.#closeAbortController.signal,
  );
  readonly #onPersist: OnPersist;
  #refreshScheduler = new ProcessScheduler(
    () => this.refresh(),
    REFRESH_IDLE_TIMEOUT_MS,
    REFRESH_THROTTLE_MS,
    this.#closeAbortController.signal,
  );

  readonly #enableLicensing: boolean;

  /**
   * The options used to control the {@link pull} and push request behavior. This
   * object is live so changes to it will affect the next pull or push call.
   */
  get requestOptions(): Required<RequestOptions> {
    return this.#requestOptions;
  }

  /**
   * `onSync(true)` is called when Replicache transitions from no push or pull
   * happening to at least one happening. `onSync(false)` is called in the
   * opposite case: when Replicache transitions from at least one push or pull
   * happening to none happening.
   *
   * This can be used in a React like app by doing something like the following:
   *
   * ```js
   * const [syncing, setSyncing] = useState(false);
   * useEffect(() => {
   *   rep.onSync = setSyncing;
   * }, [rep]);
   * ```
   */
  onSync: ((syncing: boolean) => void) | null = null;

  /**
   * `onClientStateNotFound` is called when the persistent client has been
   * garbage collected. This can happen if the client has no pending mutations
   * and has not been used for a while.
   *
   * The default behavior is to reload the page (using `location.reload()`). Set
   * this to `null` or provide your own function to prevent the page from
   * reloading automatically.
   */
  onClientStateNotFound: (() => void) | null = reload;

  /**
   * `onUpdateNeeded` is called when a code update is needed.
   *
   * A code update can be needed because:
   * - the server no longer supports the {@link pushVersion},
   *   {@link pullVersion} or {@link schemaVersion} of the current code.
   * - a new Replicache client has created a new client group, because its code
   *   has different mutators, indexes, schema version and/or format version
   *   from this Replicache client. This is likely due to the new client having
   *   newer code. A code update is needed to be able to locally sync with this
   *   new Replicache client (i.e. to sync while offline, the clients can still
   *   sync with each other via the server).
   *
   * The default behavior is to reload the page (using `location.reload()`). Set
   * this to `null` or provide your own function to prevent the page from
   * reloading automatically. You may want to provide your own function to
   * display a toast to inform the end user there is a new version of your app
   * available and prompting them to refresh.
   */
  onUpdateNeeded: ((reason: UpdateNeededReason) => void) | null = reload;

  /**
   * This gets called when we get an HTTP unauthorized (401) response from the
   * push or pull endpoint. Set this to a function that will ask your user to
   * reauthenticate.
   */
  getAuth: (() => MaybePromise<string | null | undefined>) | null | undefined =
    null;

  // These three are used for testing
  onPushInvoked = () => undefined;
  onBeginPull = () => undefined;
  onRecoverMutations = (r: Promise<boolean>) => r;

  constructor(
    options: ReplicacheOptions<MD>,
    implOptions: ReplicacheImplOptions = {},
  ) {
    validateOptions(options);
    const {
      name,
      logLevel = 'info',
      logSinks = [consoleLogSink],
      pullURL = '',
      auth,
      pushDelay = 10,
      pushURL = '',
      schemaVersion = '',
      pullInterval = 60000,
      mutators = {} as MD,
      requestOptions = {},
      puller,
      pusher,
      licenseKey,
      indexes = {},
      clientMaxAgeMs = CLIENT_MAX_INACTIVE_TIME,
    } = options;
    const {
      enableMutationRecovery = true,
      enableLicensing = true,
      enableScheduledPersist = true,
      enableScheduledRefresh = true,
      enablePullAndPushInOpen = true,
      makeSubscriptionsManager = defaultMakeSubscriptionsManager,
      enableClientGroupForking = true,
    } = implOptions;
    this.auth = auth ?? '';
    this.pullURL = pullURL;
    this.pushURL = pushURL;
    this.name = name;
    this.schemaVersion = schemaVersion;
    this.pullInterval = pullInterval;
    this.pushDelay = pushDelay;
    this.puller = puller ?? getDefaultPuller(this);
    this.pusher = pusher ?? getDefaultPusher(this);

    this.#enableLicensing = enableLicensing;
    this.#enableScheduledPersist = enableScheduledPersist;
    this.#enableScheduledRefresh = enableScheduledRefresh;
    this.#enablePullAndPushInOpen = enablePullAndPushInOpen;

    this.#lc = createLogContext(logLevel, logSinks, {name});
    this.#lc.debug?.('Constructing Replicache', {
      name,
      'replicache version': version,
    });

    this.subscriptions = makeSubscriptionsManager(
      this.#queryInternal,
      this.#lc,
    );

    const kvStoreProvider = getKVStoreProvider(this.#lc, options.kvStore);
    this.#kvStoreProvider = kvStoreProvider;

    const perKVStore = kvStoreProvider.create(this.idbName);

    this.#idbDatabases = new IDBDatabasesStore(kvStoreProvider.create);
    this.perdag = new StoreImpl(perKVStore, newRandomHash, assertHash);
    this.memdag = new LazyStore(
      this.perdag,
      LAZY_STORE_SOURCE_CHUNK_CACHE_SIZE_LIMIT,
      newRandomHash,
      assertHash,
    );

    // Use a promise-resolve pair so that we have a promise to use even before
    // we call the Open RPC.
    const readyResolver = resolver<void>();
    this.#ready = readyResolver.promise;

    this.#licenseKey = licenseKey;
    const licenseCheckResolver = resolver<boolean>();
    this.licenseCheckPromise = licenseCheckResolver.promise;
    const licenseActiveResolver = resolver<boolean>();
    this.licenseActivePromise = licenseActiveResolver.promise;

    const {minDelayMs = MIN_DELAY_MS, maxDelayMs = MAX_DELAY_MS} =
      requestOptions;
    this.#requestOptions = {maxDelayMs, minDelayMs};

    const visibilityWatcher = getDocumentVisibilityWatcher(
      getDocument(),
      0,
      this.#closeAbortController.signal,
    );

    this.#pullConnectionLoop = new ConnectionLoop(
      this.#lc.withContext('PULL'),
      new PullDelegate(this, () => this.#invokePull()),
      visibilityWatcher,
    );

    this.#pushConnectionLoop = new ConnectionLoop(
      this.#lc.withContext('PUSH'),
      new PushDelegate(this, () => this.#invokePush()),
    );

    this.mutate = this.#registerMutators(mutators);

    const profileIDResolver = resolver<string>();
    this.#profileIDPromise = profileIDResolver.promise;
    const clientGroupIDResolver = resolver<string>();
    this.#clientGroupIDPromise = clientGroupIDResolver.promise;

    this.#mutationRecovery = new MutationRecovery({
      delegate: this,
      lc: this.#lc,
      enableMutationRecovery,
      wrapInOnlineCheck: this.#wrapInOnlineCheck.bind(this),
      wrapInReauthRetries: this.#wrapInReauthRetries.bind(this),
      isPullDisabled: this.#isPullDisabled.bind(this),
      isPushDisabled: this.#isPushDisabled.bind(this),
      clientGroupIDPromise: this.#clientGroupIDPromise,
    });

    this.#onPersist = initOnPersistChannel(
      this.name,
      this.#closeAbortController.signal,
      persistInfo => {
        void this.#handlePersist(persistInfo);
      },
    );

    void this.#open(
      indexes,
      enableClientGroupForking,
      clientMaxAgeMs,
      profileIDResolver.resolve,
      clientGroupIDResolver.resolve,
      readyResolver.resolve,
      licenseCheckResolver.resolve,
      licenseActiveResolver.resolve,
    );
  }

  async #open(
    indexes: IndexDefinitions,
    enableClientGroupForking: boolean,
    clientMaxAgeMs: number,
    profileIDResolver: (profileID: string) => void,
    resolveClientGroupID: (clientGroupID: ClientGroupID) => void,
    resolveReady: () => void,
    resolveLicenseCheck: (valid: boolean) => void,
    resolveLicenseActive: (active: boolean) => void,
  ): Promise<void> {
    const {clientID} = this;
    // If we are currently closing a Replicache instance with the same name,
    // wait for it to finish closing.
    await closingInstances.get(this.name);
    await this.#idbDatabases.getProfileID().then(profileIDResolver);
    await this.#idbDatabases.putDatabase(this.#idbDatabase);
    const [client, headHash, clients, isNewClientGroup] = await initClientV6(
      clientID,
      this.#lc,
      this.perdag,
      Object.keys(this.#mutatorRegistry),
      indexes,
      FormatVersion.Latest,
      enableClientGroupForking,
    );

    resolveClientGroupID(client.clientGroupID);
    await withWrite(this.memdag, write =>
      write.setHead(DEFAULT_HEAD_NAME, headHash),
    );

    // Now we have a profileID, a clientID, a clientGroupID and DB!
    resolveReady();

    await this.#licenseCheck(resolveLicenseCheck);

    if (this.#enablePullAndPushInOpen) {
      this.pull().catch(noop);
      this.push().catch(noop);
    }

    const {signal} = this.#closeAbortController;

    startHeartbeats(
      clientID,
      this.perdag,
      () => {
        this.#clientStateNotFoundOnClient(clientID);
      },
      HEARTBEAT_INTERVAL,
      this.#lc,
      signal,
    );
    initClientGC(
      clientID,
      this.perdag,
      clientMaxAgeMs,
      GC_INTERVAL,
      this.#lc,
      signal,
    );
    initCollectIDBDatabases(
      this.#idbDatabases,
      this.#kvStoreProvider.drop,
      COLLECT_IDB_INTERVAL,
      INITIAL_COLLECT_IDB_DELAY,
      SDD_IDB_MAX_AGE,
      2 * clientMaxAgeMs,
      this.#lc,
      signal,
    );
    initClientGroupGC(this.perdag, this.#lc, signal);
    initNewClientChannel(
      this.name,
      this.idbName,
      signal,
      client.clientGroupID,
      isNewClientGroup,
      () => {
        this.#fireOnUpdateNeeded(updateNeededReasonNewClientGroup);
      },
      this.perdag,
    );

    setIntervalWithSignal(
      () => this.recoverMutations(),
      RECOVER_MUTATIONS_INTERVAL_MS,
      signal,
    );
    void this.recoverMutations(clients);

    getDocument()?.addEventListener(
      'visibilitychange',
      this.#onVisibilityChange,
    );

    await this.#startLicenseActive(resolveLicenseActive, this.#lc, signal);
  }

  #onVisibilityChange = async () => {
    if (this.#closed) {
      return;
    }

    // In case of running in a worker, we don't have a document.
    if (getDocument()?.visibilityState !== 'visible') {
      return;
    }

    await this.#checkForClientStateNotFoundAndCallHandler();
  };

  async #checkForClientStateNotFoundAndCallHandler(): Promise<boolean> {
    const {clientID} = this;
    const hasClientState = await withRead(this.perdag, read =>
      persistHasClientState(clientID, read),
    );
    if (!hasClientState) {
      this.#clientStateNotFoundOnClient(clientID);
    }
    return !hasClientState;
  }

  async #licenseCheck(
    resolveLicenseCheck: (valid: boolean) => void,
  ): Promise<void> {
    if (!this.#enableLicensing) {
      resolveLicenseCheck(true);
      return;
    }
    if (!this.#licenseKey) {
      await this.#licenseInvalid(
        this.#lc,
        `license key ReplicacheOptions.licenseKey is not set`,
        true /* disable replicache */,
        resolveLicenseCheck,
      );
      return;
    }
    this.#lc.debug?.(`Replicache license key: ${this.#licenseKey}`);
    if (this.#licenseKey === TEST_LICENSE_KEY) {
      this.#lc.info?.(
        `Skipping license check for TEST_LICENSE_KEY. ` +
          `You may ONLY use this key for automated (e.g., unit/CI) testing. ` +
          // TODO(phritz) maybe use a more specific URL
          `See https://replicache.dev for more information.`,
      );
      resolveLicenseCheck(true);

      this.#testLicenseKeyTimeout = setTimeout(async () => {
        await this.#licenseInvalid(
          this.#lc,
          'Test key expired',
          true,
          resolveLicenseCheck,
        );
      }, TEST_LICENSE_KEY_TTL_MS);

      return;
    }
    try {
      const resp = await getLicenseStatus(
        mustSimpleFetch,
        PROD_LICENSE_SERVER_URL,
        this.#licenseKey,
        this.#lc,
      );
      if (resp.pleaseUpdate) {
        this.#lc.error?.(
          `You are using an old version of Replicache that uses deprecated licensing features. ` +
            `Please update Replicache else it may stop working.`,
        );
      }
      if (resp.status === LicenseStatus.Valid) {
        this.#lc.debug?.(`License is valid.`);
      } else {
        await this.#licenseInvalid(
          this.#lc,
          `status: ${resp.status}`,
          resp.disable,
          resolveLicenseCheck,
        );
        return;
      }
    } catch (err) {
      this.#lc.error?.(`Error checking license: ${err}`);
      // Note: on error we fall through to assuming the license is valid.
    }
    resolveLicenseCheck(true);
  }

  async #licenseInvalid(
    lc: LogContext,
    reason: string,
    disable: boolean,
    resolveLicenseCheck: (valid: boolean) => void,
  ): Promise<void> {
    lc.error?.(
      `** REPLICACHE LICENSE NOT VALID ** Replicache license key '${
        this.#licenseKey
      }' is not valid (${reason}). ` +
        `Please run 'npx replicache get-license' to get a license key or contact hello@replicache.dev for help.`,
    );
    if (disable) {
      await this.close();
      lc.error?.(`** REPLICACHE DISABLED **`);
    }
    resolveLicenseCheck(false);
    return;
  }

  async #startLicenseActive(
    resolveLicenseActive: (valid: boolean) => void,
    lc: LogContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      !this.#enableLicensing ||
      !this.#licenseKey ||
      this.#licenseKey === TEST_LICENSE_KEY
    ) {
      resolveLicenseActive(false);
      return;
    }

    const markActive = async () => {
      try {
        await licenseActive(
          mustSimpleFetch,
          PROD_LICENSE_SERVER_URL,
          this.#licenseKey as string,
          await this.profileID,
          lc,
        );
      } catch (err) {
        this.#lc.info?.(`Error sending license active ping: ${err}`);
      }
    };
    await markActive();
    resolveLicenseActive(true);

    initBgIntervalProcess(
      'LicenseActive',
      markActive,
      () => LICENSE_ACTIVE_INTERVAL_MS,
      lc,
      signal,
    );
  }

  /**
   * The browser profile ID for this browser profile. Every instance of Replicache
   * browser-profile-wide shares the same profile ID.
   */
  get profileID(): Promise<string> {
    return this.#profileIDPromise;
  }

  /**
   * The client ID for this instance of Replicache. Each instance of Replicache
   * gets a unique client ID.
   */
  get clientID(): string {
    return this.#clientID;
  }

  /**
   * The client group ID for this instance of Replicache. Instances of
   * Replicache will have the same client group ID if and only if they have
   * the same name, mutators, indexes, schema version, format version, and
   * browser profile.
   */
  get clientGroupID(): Promise<string> {
    return this.#clientGroupIDPromise;
  }

  /**
   * `onOnlineChange` is called when the {@link online} property changes. See
   * {@link online} for more details.
   */
  onOnlineChange: ((online: boolean) => void) | null = null;

  /**
   * A rough heuristic for whether the client is currently online. Note that
   * there is no way to know for certain whether a client is online - the next
   * request can always fail. This property returns true if the last sync attempt succeeded,
   * and false otherwise.
   */
  get online(): boolean {
    return this.#online;
  }

  /**
   * Whether the Replicache database has been closed. Once Replicache has been
   * closed it no longer syncs and you can no longer read or write data out of
   * it. After it has been closed it is pretty much useless and should not be
   * used any more.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Closes this Replicache instance.
   *
   * When closed all subscriptions end and no more read or writes are allowed.
   */
  async close(): Promise<void> {
    this.#closed = true;
    const {promise, resolve} = resolver();
    closingInstances.set(this.name, promise);

    this.#closeAbortController.abort();

    getDocument()?.removeEventListener(
      'visibilitychange',
      this.#onVisibilityChange,
    );

    await this.#ready;
    const closingPromises = [
      this.memdag.close(),
      this.perdag.close(),
      this.#idbDatabases.close(),
    ];

    this.#pullConnectionLoop.close();
    this.#pushConnectionLoop.close();

    this.subscriptions.clear();

    if (this.#testLicenseKeyTimeout) {
      clearTimeout(this.#testLicenseKeyTimeout);
    }

    await Promise.all(closingPromises);
    closingInstances.delete(this.name);
    resolve();
  }

  async maybeEndPull(syncHead: Hash, requestID: string): Promise<void> {
    for (;;) {
      if (this.#closed) {
        return;
      }

      await this.#ready;
      const {clientID} = this;
      const lc = this.#lc
        .withContext('maybeEndPull')
        .withContext('requestID', requestID);
      const {replayMutations, diffs} = await maybeEndPull<LocalMeta>(
        this.memdag,
        lc,
        syncHead,
        clientID,
        this.subscriptions,
        FormatVersion.Latest,
      );

      if (!replayMutations || replayMutations.length === 0) {
        // All done.
        await this.subscriptions.fire(diffs);
        void this.#schedulePersist();
        return;
      }

      // Replay.
      for (const mutation of replayMutations) {
        // TODO(greg): I'm not sure why this was in Replicache#_mutate...
        // Ensure that we run initial pending subscribe functions before starting a
        // write transaction.
        if (this.subscriptions.hasPendingSubscriptionRuns) {
          await Promise.resolve();
        }
        const {meta} = mutation;
        syncHead = await withWriteNoImplicitCommit(this.memdag, dagWrite =>
          rebaseMutationAndCommit(
            mutation,
            dagWrite,
            syncHead,
            SYNC_HEAD_NAME,
            this.#mutatorRegistry,
            lc,
            isLocalMetaDD31(meta) ? meta.clientID : clientID,
            FormatVersion.Latest,
          ),
        );
      }
    }
  }

  #invokePull(): Promise<boolean> {
    if (this.#isPullDisabled()) {
      return Promise.resolve(true);
    }

    return this.#wrapInOnlineCheck(async () => {
      try {
        this.#changeSyncCounters(0, 1);
        const {syncHead, requestID, ok} = await this.beginPull();
        if (!ok) {
          return false;
        }
        if (syncHead !== emptyHash) {
          await this.maybeEndPull(syncHead, requestID);
        }
      } catch (e) {
        throw await this.#convertToClientStateNotFoundError(e);
      } finally {
        this.#changeSyncCounters(0, -1);
      }
      return true;
    }, 'Pull');
  }

  #isPullDisabled() {
    return (
      this.isClientGroupDisabled ||
      (this.pullURL === '' && isDefaultPuller(this.puller))
    );
  }

  async #wrapInOnlineCheck(
    f: () => Promise<boolean>,
    name: string,
  ): Promise<boolean> {
    let online = true;

    try {
      return await f();
    } catch (e) {
      // The error paths of beginPull and maybeEndPull need to be reworked.
      //
      // We want to distinguish between:
      // a) network requests failed -- we're offline basically
      // b) sync was aborted because one's already in progress
      // c) oh noes - something unexpected happened
      //
      // Right now, all of these come out as errors. We distinguish (b) with a
      // hacky string search. (a) and (c) are not distinguishable currently
      // because repc doesn't provide sufficient information, so we treat all
      // errors that aren't (b) as (a).
      if (e instanceof PushError || e instanceof PullError) {
        online = false;
        this.#lc.debug?.(`${name} threw:\n`, e, '\nwith cause:\n', e.causedBy);
      } else if (e instanceof ReportError) {
        this.#lc.error?.(e);
      } else {
        this.#lc.info?.(`${name} threw:\n`, e);
      }
      return false;
    } finally {
      if (this.#online !== online) {
        this.#online = online;
        this.onOnlineChange?.(online);
        if (online) {
          void this.recoverMutations();
        }
      }
    }
  }

  async #wrapInReauthRetries<R>(
    f: (
      requestID: string,
      requestLc: LogContext,
    ) => Promise<{
      httpRequestInfo: HTTPRequestInfo | undefined;
      result: R;
    }>,
    verb: string,
    lc: LogContext,
    preAuth: () => MaybePromise<void> = noop,
    postAuth: () => MaybePromise<void> = noop,
  ): Promise<{
    result: R;
    authFailure: boolean;
  }> {
    const {clientID} = this;
    let reauthAttempts = 0;
    let lastResult;
    lc = lc.withContext(verb);
    do {
      const requestID = newRequestID(clientID);
      const requestLc = lc.withContext('requestID', requestID);
      const {httpRequestInfo, result} = await f(requestID, requestLc);
      lastResult = result;
      if (!httpRequestInfo) {
        return {
          result,
          authFailure: false,
        };
      }
      const {errorMessage, httpStatusCode} = httpRequestInfo;

      if (errorMessage || httpStatusCode !== 200) {
        // TODO(arv): Maybe we should not log the server URL when the error comes
        // from a Pusher/Puller?
        requestLc.error?.(
          `Got a non 200 response doing ${verb}: ${httpStatusCode}` +
            (errorMessage ? `: ${errorMessage}` : ''),
        );
      }
      if (httpStatusCode !== httpStatusUnauthorized) {
        return {
          result,
          authFailure: false,
        };
      }
      if (!this.getAuth) {
        return {
          result,
          authFailure: true,
        };
      }
      let auth;
      try {
        await preAuth();
        auth = await this.getAuth();
      } finally {
        await postAuth();
      }
      if (auth === null || auth === undefined) {
        return {
          result,
          authFailure: true,
        };
      }
      this.auth = auth;
      reauthAttempts++;
    } while (reauthAttempts < MAX_REAUTH_TRIES);
    lc.info?.('Tried to reauthenticate too many times');
    return {
      result: lastResult,
      authFailure: true,
    };
  }

  #isPushDisabled() {
    return (
      this.isClientGroupDisabled ||
      (this.pushURL === '' && isDefaultPusher(this.pusher))
    );
  }

  async #invokePush(): Promise<boolean> {
    if (TESTING) {
      this.onPushInvoked();
    }
    if (this.#isPushDisabled()) {
      return true;
    }

    await this.#ready;
    const profileID = await this.#profileIDPromise;
    const {clientID} = this;
    const clientGroupID = await this.#clientGroupIDPromise;
    return this.#wrapInOnlineCheck(async () => {
      const {result: pusherResult} = await this.#wrapInReauthRetries(
        async (requestID: string, requestLc: LogContext) => {
          try {
            this.#changeSyncCounters(1, 0);
            const pusherResult = await push(
              requestID,
              this.memdag,
              requestLc,
              profileID,
              clientGroupID,
              clientID,
              this.pusher,
              this.schemaVersion,
              PUSH_VERSION_DD31,
            );
            return {
              result: pusherResult,
              httpRequestInfo: pusherResult?.httpRequestInfo,
            };
          } finally {
            this.#changeSyncCounters(-1, 0);
          }
        },
        'push',
        this.#lc,
      );

      if (pusherResult === undefined) {
        // No pending mutations.
        return true;
      }

      const {response, httpRequestInfo} = pusherResult;

      if (isVersionNotSupportedResponse(response)) {
        this.#handleVersionNotSupportedResponse(response);
      } else if (isClientStateNotFoundResponse(response)) {
        await this.#clientStateNotFoundOnServer();
      }

      // No pushResponse means we didn't do a push because there were no
      // pending mutations.
      return httpRequestInfo.httpStatusCode === 200;
    }, 'Push');
  }

  #handleVersionNotSupportedResponse(response: VersionNotSupportedResponse) {
    const reason: UpdateNeededReason = {
      type: response.error,
    };
    if (response.versionType) {
      reason.versionType = response.versionType;
    }
    this.#fireOnUpdateNeeded(reason);
  }

  /**
   * Push pushes pending changes to the {@link pushURL}.
   *
   * You do not usually need to manually call push. If {@link pushDelay} is
   * non-zero (which it is by default) pushes happen automatically shortly after
   * mutations.
   *
   * If the server endpoint fails push will be continuously retried with an
   * exponential backoff.
   *
   * @param [now=false] If true, push will happen immediately and ignore
   *   {@link pushDelay}, {@link RequestOptions.minDelayMs} as well as the
   *   exponential backoff in case of errors.
   * @returns A promise that resolves when the next push completes. In case of
   * errors the first error will reject the returned promise. Subsequent errors
   * will not be reflected in the promise.
   */
  push({now = false} = {}): Promise<void> {
    return throwIfError(this.#pushConnectionLoop.send(now));
  }

  /**
   * Pull pulls changes from the {@link pullURL}. If there are any changes local
   * changes will get replayed on top of the new server state.
   *
   * If the server endpoint fails pull will be continuously retried with an
   * exponential backoff.
   *
   * @param [now=false] If true, pull will happen immediately and ignore
   *   {@link RequestOptions.minDelayMs} as well as the exponential backoff in
   *   case of errors.
   * @returns A promise that resolves when the next pull completes. In case of
   * errors the first error will reject the returned promise. Subsequent errors
   * will not be reflected in the promise.
   */
  pull({now = false} = {}): Promise<void> {
    return throwIfError(this.#pullConnectionLoop.send(now));
  }

  /**
   * Applies an update from the server to Replicache.
   * Throws an error if cookie does not match. In that case the server thinks
   * this client has a different cookie than it does; the caller should disconnect
   * from the server and re-register, which transmits the cookie the client actually
   * has.
   *
   * @experimental This method is under development and its semantics will change.
   */
  async poke(poke: PokeInternal): Promise<void> {
    await this.#ready;
    // TODO(MP) Previously we created a request ID here and included it with the
    // PullRequest to the server so we could tie events across client and server
    // together. Since the direction is now reversed, creating and adding a request ID
    // here is kind of silly. We should consider creating the request ID
    // on the *server* and passing it down in the poke for inclusion here in the log
    // context
    const {clientID} = this;
    const requestID = newRequestID(clientID);
    const lc = this.#lc
      .withContext('handlePullResponse')
      .withContext('requestID', requestID);

    const {pullResponse} = poke;

    if (isVersionNotSupportedResponse(pullResponse)) {
      this.#handleVersionNotSupportedResponse(pullResponse);
      return;
    }

    if (isClientStateNotFoundResponse(pullResponse)) {
      await this.#clientStateNotFoundOnServer();
      return;
    }

    const result = await handlePullResponseV1(
      lc,
      this.memdag,
      deepFreeze(poke.baseCookie),
      pullResponse,
      clientID,
      FormatVersion.Latest,
    );

    switch (result.type) {
      case HandlePullResponseResultType.Applied:
        await this.maybeEndPull(result.syncHead, requestID);
        break;
      case HandlePullResponseResultType.CookieMismatch:
        throw new Error(
          'unexpected base cookie for poke: ' + JSON.stringify(poke),
        );
        break;
      case HandlePullResponseResultType.NoOp:
        break;
    }
  }

  async beginPull(): Promise<BeginPullResult> {
    if (TESTING) {
      this.onBeginPull();
    }
    await this.#ready;
    const profileID = await this.profileID;
    const {clientID} = this;
    const clientGroupID = await this.#clientGroupIDPromise;
    const {
      result: {beginPullResponse, requestID},
    } = await this.#wrapInReauthRetries(
      async (requestID: string, requestLc: LogContext) => {
        const beginPullResponse = await beginPullV1(
          profileID,
          clientID,
          clientGroupID,
          this.schemaVersion,
          this.puller,
          requestID,
          this.memdag,
          FormatVersion.Latest,
          requestLc,
        );
        return {
          result: {beginPullResponse, requestID},
          httpRequestInfo: beginPullResponse.httpRequestInfo,
        };
      },
      'pull',
      this.#lc,
      () => this.#changeSyncCounters(0, -1),
      () => this.#changeSyncCounters(0, 1),
    );

    const {pullResponse} = beginPullResponse;
    if (isVersionNotSupportedResponse(pullResponse)) {
      this.#handleVersionNotSupportedResponse(pullResponse);
    } else if (isClientStateNotFoundResponse(beginPullResponse.pullResponse)) {
      await this.#clientStateNotFoundOnServer();
    }

    const {syncHead, httpRequestInfo} = beginPullResponse;
    return {requestID, syncHead, ok: httpRequestInfo.httpStatusCode === 200};
  }

  async persist(): Promise<void> {
    assert(!this.#persistIsRunning);
    this.#persistIsRunning = true;
    try {
      const {clientID} = this;
      await this.#ready;
      if (this.#closed) {
        return;
      }
      try {
        await persistDD31(
          this.#lc,
          clientID,
          this.memdag,
          this.perdag,
          this.#mutatorRegistry,
          () => this.closed,
          FormatVersion.Latest,
        );
      } catch (e) {
        if (e instanceof ClientStateNotFoundError) {
          this.#clientStateNotFoundOnClient(clientID);
        } else if (this.#closed) {
          this.#lc.debug?.('Exception persisting during close', e);
        } else {
          throw e;
        }
      }
    } finally {
      this.#persistIsRunning = false;
    }

    const {clientID} = this;
    const clientGroupID = await this.#clientGroupIDPromise;
    assert(clientGroupID);
    this.#onPersist({clientID, clientGroupID});
  }

  async refresh(): Promise<void> {
    await this.#ready;
    const {clientID} = this;
    if (this.#closed) {
      return;
    }
    let diffs;
    try {
      diffs = await refresh(
        this.#lc,
        this.memdag,
        this.perdag,
        clientID,
        this.#mutatorRegistry,
        this.subscriptions,
        () => this.closed,
        FormatVersion.Latest,
      );
    } catch (e) {
      if (e instanceof ClientStateNotFoundError) {
        this.#clientStateNotFoundOnClient(clientID);
      } else if (this.#closed) {
        this.#lc.debug?.('Exception refreshing during close', e);
      } else {
        throw e;
      }
    }
    if (diffs !== undefined) {
      await this.subscriptions.fire(diffs);
    }
  }

  #fireOnClientStateNotFound() {
    this.onClientStateNotFound?.();
  }

  #clientStateNotFoundOnClient(clientID: ClientID) {
    this.#lc.error?.(`Client state not found on client, clientID: ${clientID}`);
    this.#fireOnClientStateNotFound();
  }

  async #clientStateNotFoundOnServer() {
    const clientGroupID = await this.#clientGroupIDPromise;
    this.#lc.error?.(
      `Client state not found on server, clientGroupID: ${clientGroupID}`,
    );
    await this.disableClientGroup();
    this.#fireOnClientStateNotFound();
  }

  async disableClientGroup(): Promise<void> {
    const clientGroupID = await this.#clientGroupIDPromise;
    assert(clientGroupID);
    this.isClientGroupDisabled = true;
    await withWrite(this.perdag, dagWrite =>
      disableClientGroup(clientGroupID, dagWrite),
    );
  }

  #fireOnUpdateNeeded(reason: UpdateNeededReason) {
    this.#lc.debug?.(`Update needed, reason: ${reason}`);
    this.onUpdateNeeded?.(reason);
  }

  async #schedulePersist(): Promise<void> {
    if (!this.#enableScheduledPersist) {
      return;
    }
    await this.#schedule('persist', this.#persistScheduler);
  }

  async #handlePersist(persistInfo: PersistInfo): Promise<void> {
    this.#lc.debug?.('Handling persist', persistInfo);
    const clientGroupID = await this.#clientGroupIDPromise;
    if (persistInfo.clientGroupID === clientGroupID) {
      void this.#scheduleRefresh();
    }
  }

  async #scheduleRefresh(): Promise<void> {
    if (!this.#enableScheduledRefresh) {
      return;
    }
    await this.#schedule('refresh from storage', this.#refreshScheduler);
  }

  async #schedule(name: string, scheduler: ProcessScheduler): Promise<void> {
    try {
      await scheduler.schedule();
    } catch (e) {
      if (e instanceof AbortError) {
        this.#lc.debug?.(`Scheduled ${name} did not complete before close.`);
      } else {
        this.#lc.error?.(`Error during ${name}`, e);
      }
    }
  }

  #changeSyncCounters(pushDelta: 0, pullDelta: 1 | -1): void;
  #changeSyncCounters(pushDelta: 1 | -1, pullDelta: 0): void;
  #changeSyncCounters(pushDelta: number, pullDelta: number): void {
    this.#pushCounter += pushDelta;
    this.#pullCounter += pullDelta;
    const delta = pushDelta + pullDelta;
    const counter = this.#pushCounter + this.#pullCounter;
    if ((delta === 1 && counter === 1) || counter === 0) {
      const syncing = counter > 0;
      // Run in a new microtask.
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      Promise.resolve().then(() => this.onSync?.(syncing));
    }
  }

  /**
   * Subscribe to the result of a {@link query}. The `body` function is
   * evaluated once and its results are returned via `onData`.
   *
   * Thereafter, each time the the result of `body` changes, `onData` is fired
   * again with the new result.
   *
   * `subscribe()` goes to significant effort to avoid extraneous work
   * re-evaluating subscriptions:
   *
   * 1. subscribe tracks the keys that `body` accesses each time it runs. `body`
   *    is only re-evaluated when those keys change.
   * 2. subscribe only re-fires `onData` in the case that a result changes by
   *    way of the `isEqual` option which defaults to doing a deep JSON value
   *    equality check.
   *
   * Because of (1), `body` must be a pure function of the data in Replicache.
   * `body` must not access anything other than the `tx` parameter passed to it.
   *
   * Although subscribe is as efficient as it can be, it is somewhat constrained
   * by the goal of returning an arbitrary computation of the cache. For even
   * better performance (but worse dx), see {@link experimentalWatch}.
   *
   * If an error occurs in the `body` the `onError` function is called if
   * present. Otherwise, the error is logged at log level 'error'.
   *
   * To cancel the subscription, call the returned function.
   *
   * @param body The function to evaluate to get the value to pass into
   *    `onData`.
   * @param options Options is either a function or an object. If it is a
   *    function it is equivalent to passing it as the `onData` property of an
   *    object.
   */
  subscribe<R>(
    body: (tx: ReadTransaction) => Promise<R>,
    options: SubscribeOptions<R> | ((result: R) => void),
  ): () => void {
    if (typeof options === 'function') {
      options = {onData: options};
    }

    const {onData, onError, onDone, isEqual} = options;
    return this.subscriptions.add(
      new SubscriptionImpl(body, onData, onError, onDone, isEqual),
    );
  }

  /**
   * Watches Replicache for changes.
   *
   * The `callback` gets called whenever the underlying data changes and the
   * `key` changes matches the `prefix` of {@link ExperimentalWatchIndexOptions} or
   * {@link ExperimentalWatchNoIndexOptions} if present. If a change
   * occurs to the data but the change does not impact the key space the
   * callback is not called. In other words, the callback is never called with
   * an empty diff.
   *
   * This gets called after commit (a mutation or a rebase).
   *
   * @experimental This method is under development and its semantics will
   * change.
   */
  experimentalWatch(callback: WatchNoIndexCallback): () => void;
  experimentalWatch<Options extends WatchOptions>(
    callback: WatchCallbackForOptions<Options>,
    options?: Options,
  ): () => void;
  experimentalWatch<Options extends WatchOptions>(
    callback: WatchCallbackForOptions<Options>,
    options?: Options,
  ): () => void {
    return this.subscriptions.add(
      new WatchSubscription(callback as WatchCallback, options),
    );
  }

  /**
   * Query is used for read transactions. It is recommended to use transactions
   * to ensure you get a consistent view across multiple calls to `get`, `has`
   * and `scan`.
   */
  query<R>(body: (tx: ReadTransaction) => Promise<R> | R): Promise<R> {
    return this.#queryInternal(body);
  }

  get cookie(): Promise<Cookie> {
    return this.#ready.then(() =>
      withRead(this.memdag, async dagRead => {
        const mainHeadHash = await dagRead.getHead(DEFAULT_HEAD_NAME);
        if (!mainHeadHash) {
          throw new Error('Internal no main head found');
        }
        const baseSnapshot = await baseSnapshotFromHash(mainHeadHash, dagRead);
        const baseSnapshotMeta = baseSnapshot.meta;
        const cookie = baseSnapshotMeta.cookieJSON;
        assertCookie(cookie);
        return cookie;
      }),
    );
  }

  #queryInternal: QueryInternal = async body => {
    await this.#ready;
    const {clientID} = this;
    return withRead(this.memdag, async dagRead => {
      try {
        const dbRead = await readFromDefaultHead(dagRead, FormatVersion.Latest);
        const tx = new ReadTransactionImpl(clientID, dbRead, this.#lc);
        return await body(tx);
      } catch (ex) {
        throw await this.#convertToClientStateNotFoundError(ex);
      }
    });
  };

  #register<Return extends ReadonlyJSONValue | void, Args extends JSONValue>(
    name: string,
    mutatorImpl: (tx: WriteTransaction, args?: Args) => MaybePromise<Return>,
  ): (args?: Args) => Promise<Return> {
    this.#mutatorRegistry[name] = mutatorImpl as (
      tx: WriteTransaction,
      args: JSONValue | undefined,
    ) => Promise<void | JSONValue>;

    return (args?: Args): Promise<Return> =>
      this.#mutate(name, mutatorImpl, args, performance.now());
  }

  #registerMutators<
    M extends {
      [key: string]: (
        tx: WriteTransaction,
        args?: ReadonlyJSONValue,
      ) => MutatorReturn;
    },
  >(regs: M): MakeMutators<M> {
    type Mut = MakeMutators<M>;
    const rv: Partial<Mut> = Object.create(null);
    for (const k in regs) {
      rv[k] = this.#register(k, regs[k]) as MakeMutator<M[typeof k]>;
    }
    return rv as Mut;
  }

  async #mutate<
    R extends ReadonlyJSONValue | void,
    A extends ReadonlyJSONValue,
  >(
    name: string,
    mutatorImpl: (tx: WriteTransaction, args?: A) => MaybePromise<R>,
    args: A | undefined,
    timestamp: number,
  ): Promise<R> {
    const frozenArgs = deepFreeze(args ?? null);

    // Ensure that we run initial pending subscribe functions before starting a
    // write transaction.
    if (this.subscriptions.hasPendingSubscriptionRuns) {
      await Promise.resolve();
    }

    await this.#ready;
    const {clientID} = this;
    return withWriteNoImplicitCommit(this.memdag, async dagWrite => {
      try {
        const headHash = await mustGetHeadHash(DEFAULT_HEAD_NAME, dagWrite);
        const originalHash = null;

        const dbWrite = await newWriteLocal(
          headHash,
          name,
          frozenArgs,
          originalHash,
          dagWrite,
          timestamp,
          clientID,
          FormatVersion.Latest,
        );

        const tx = new WriteTransactionImpl(
          clientID,
          await dbWrite.getMutationID(),
          'initial',
          dbWrite,
          this.#lc,
        );
        const result: R = await mutatorImpl(tx, args);
        throwIfClosed(dbWrite);
        const lastMutationID = await dbWrite.getMutationID();
        const diffs = await dbWrite.commitWithDiffs(
          DEFAULT_HEAD_NAME,
          this.subscriptions,
        );

        // Update this after the commit in case the commit fails.
        this.lastMutationID = lastMutationID;

        // Send is not supposed to reject
        this.#pushConnectionLoop.send(false).catch(() => void 0);
        await this.subscriptions.fire(diffs);
        void this.#schedulePersist();
        return result;
      } catch (ex) {
        throw await this.#convertToClientStateNotFoundError(ex);
      }
    });
  }

  /**
   * In the case we get a ChunkNotFoundError we check if the client got garbage
   * collected and if so change the error to a ClientStateNotFoundError instead
   */
  async #convertToClientStateNotFoundError(ex: unknown): Promise<unknown> {
    if (
      ex instanceof ChunkNotFoundError &&
      (await this.#checkForClientStateNotFoundAndCallHandler())
    ) {
      return new ClientStateNotFoundError(this.clientID);
    }

    return ex;
  }

  recoverMutations(preReadClientMap?: ClientMap): Promise<boolean> {
    const result = this.#mutationRecovery.recoverMutations(
      preReadClientMap,
      this.#ready,
      this.perdag,
      this.#idbDatabase,
      this.#idbDatabases,
      this.#kvStoreProvider.create,
    );
    if (TESTING) {
      void this.onRecoverMutations(result);
    }
    return result;
  }

  /**
   * List of pending mutations. The order of this is from oldest to newest.
   *
   * Gives a list of local mutations that have `mutationID` >
   * `syncHead.mutationID` that exists on the main client group.
   *
   * @experimental This method is experimental and may change in the future.
   */
  experimentalPendingMutations(): Promise<readonly PendingMutation[]> {
    return withRead(this.memdag, pendingMutationsForAPI);
  }
}

// This map is used to keep track of closing instances of Replicache. When an
// instance is opening we wait for any currently closing instances.
const closingInstances: Map<string, Promise<unknown>> = new Map();

async function throwIfError(p: Promise<undefined | {error: unknown}>) {
  const res = await p;
  if (res) {
    throw res.error;
  }
}

function reload(): void {
  if (typeof location !== 'undefined') {
    location.reload();
  }
}

function validateOptions<MD extends MutatorDefs>(
  options: ReplicacheOptions<MD>,
): void {
  const {name, clientMaxAgeMs} = options;
  if (typeof name !== 'string' || !name) {
    throw new TypeError('name is required and must be non-empty');
  }

  if (clientMaxAgeMs !== undefined) {
    const min = Math.max(GC_INTERVAL, HEARTBEAT_INTERVAL);
    if (typeof clientMaxAgeMs !== 'number' || clientMaxAgeMs <= min) {
      throw new TypeError(
        `clientAgeMaxMs must be a number larger than ${min}ms`,
      );
    }
  }
}
