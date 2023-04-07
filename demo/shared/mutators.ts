import type {ReadTransaction, WriteTransaction} from '@rocicorp/reflect';
import {
  ActorID,
  Cursor,
  Env,
  Letter,
  Position,
  Splatter,
  Vector,
} from './types';
import {nextNumber, randomWithSeed, sortableKeyNum} from './util';
import {chunk, unchunk} from './chunks';
import {LETTERS} from './letters';
import {draw_cache_png} from '../../vendor/renderer/renderer';
import {splatters2Render} from './wasm-args';
import {
  SPLATTER_ANIM_FRAMES,
  SPLATTER_FLATTEN_FREQUENCY,
  SPLATTER_MAX_AGE,
} from './constants';
import {encode, decode} from './uint82b64';

export const UNINITIALIZED_CACHE_SENTINEL = 'uninitialized-cache-sentinel';
export const UNINITIALIZED_CLEARED_SENTINEL = 'uninitialized-clear-sentinel';

export const splatterId = (s: Splatter) =>
  `${s.u}${s.t}${s.x.toFixed(1) + s.y.toFixed(1)}}`;

export type M = typeof mutators;

let env = Env.CLIENT;
let _initRenderer: (() => Promise<void>) | undefined;
export const setEnv = (e: Env, initRenderer: () => Promise<void>) => {
  env = e;
  _initRenderer = initRenderer;
};

// Seeds are used for creating pseudo-random values that are stable across
// server and client. (see: randomWithSeed)
const Seeds = {
  splatterAnimation: 2398,
  splatterRotation: 9847,
};

const clientConsoleMap = new Map<string, (log: string) => void>();

export function registerClientConsole(
  clientId: string,
  log: (log: string) => void,
) {
  clientConsoleMap.set(clientId, log);
}

export function deregisterClientConsole(clientId: string) {
  clientConsoleMap.delete(clientId);
}

const logsPrefix = 'refect-server-log';
export const entriesPrefix = `${logsPrefix}/entries/`;
export const entriesCountKey = `${logsPrefix}/count`;

function entriesKey(count: number): string {
  return `${entriesPrefix}${count.toString().padStart(10, '0')}`;
}

export async function getServerLogCount(tx: WriteTransaction): Promise<number> {
  return ((await tx.get(entriesCountKey)) as number) ?? 0;
}

export async function getServerLogs(tx: ReadTransaction): Promise<string[]> {
  return (await tx
    .scan({prefix: entriesPrefix})
    .values()
    .toArray()) as string[];
}

export async function addServerLog(tx: WriteTransaction, log: string) {
  if (tx.environment !== 'server') {
    return;
  }
  const count = await getServerLogCount(tx);
  await tx.put(entriesKey(count), log);
  await tx.put(entriesCountKey, count + 1);
}
export const mutators = {
  initialize: async (tx: WriteTransaction) => {
    // We'd like to prevent drawing our local client until we load the server cache
    // - so when a client initializes, write a sentinel value into all the caches,
    // then replace it with empty data or the real cache on the server. This allows
    // us to prevent interactivity until all the caches are non-sentinel.
    if (env === Env.CLIENT) {
      for await (const letter of LETTERS) {
        await chunk(tx, `cache/${letter}`, UNINITIALIZED_CACHE_SENTINEL);
      }
      await tx.put('cleared', UNINITIALIZED_CLEARED_SENTINEL);
    }
    // Doing nothing on the server is equivalent to throwing out the sentinel value.
  },
  setPresentActors: async (tx: WriteTransaction, actors: ActorID[]) => {
    const allCursors = (await tx
      .scan({prefix: 'cursor/'})
      .entries()
      .toArray()) as [string, Cursor][];
    const actorIds = new Set(actors);
    for await (const [key, cursor] of allCursors) {
      if (!actorIds.has(cursor.actorId)) {
        await tx.del(key);
      }
    }
  },
  updateCursor: async (tx: WriteTransaction, cursor: Cursor) => {
    await tx.put(`cursor/${cursor.actorId}`, cursor);
  },
  clearTextures: async (tx: WriteTransaction, time: number) => {
    const cacheKeys = await tx.scan({prefix: `cache/`}).keys();
    for await (const k of cacheKeys) {
      await tx.del(k);
    }
    const splatters = (await tx
      .scan({prefix: 'splatter/'})
      .keys()
      .toArray()) as string[];
    for await (const k of splatters) {
      await tx.del(k);
    }
    // To provide a synced animation and to deal with the case where some clients
    // may only have local cached splatters which we can't clean up individually
    // (because they are already rendered), we also add a "cleared" timestamp which
    // will let us run an animation on all the clients when they receive it.
    await tx.put('cleared', time);
  },
  addSplatter: async (
    tx: WriteTransaction,
    {
      letter,
      actorId,
      colorIndex,
      texturePosition,
      timestamp,
      large,
    }: {
      letter: Letter;
      actorId: string;
      colorIndex: number;
      texturePosition: Position;
      timestamp: number;
      large: boolean;
      hitPosition: Vector;
    },
  ) => {
    const {x, y} = texturePosition;
    const splatter: Splatter = {
      x,
      y,
      u: actorId,
      c: colorIndex,
      s: large ? 1 : 0,
      t: timestamp,
      a: Math.floor(randomWithSeed(timestamp, Seeds.splatterAnimation, 5)),
      r: Math.floor(randomWithSeed(timestamp, Seeds.splatterRotation, 4)),
    };
    // Because data is returned in key order rather than insert order, we need to
    // increment a global counter.
    const splatterNum = nextNumber(
      (await tx.get(`splatter-num/${letter}`)) as number,
    );
    // Convert to hex so that it will sort correctly
    await tx.put(
      `splatter/${letter}/${sortableKeyNum(splatterNum)}/${actorId}`,
      splatter,
    );
    await tx.put(`splatter-num/${letter}`, splatterNum);

    // On the server, perform periodic flattening
    if (env === Env.SERVER && splatterNum % SPLATTER_FLATTEN_FREQUENCY === 0) {
      await flattenCache(tx, timestamp, letter);
    }
  },
  // These mutators are for the how it works demos
  increment: async (
    tx: WriteTransaction,
    {key, delta}: {key: string; delta: number},
  ) => {
    const prev = ((await tx.get(key)) as number) ?? 0;
    const next = prev + delta;
    await tx.put(key, next);
    clientConsoleMap.get(tx.clientID)?.(
      `Running mutation ${tx.mutationID} from ${tx.clientID} on client: ${prev} → ${next}`,
    );
    await addServerLog(
      tx,
      `Running mutation ${tx.mutationID} from ` +
        `${tx.clientID} on ${tx.environment}: ` +
        `${prev} → ${next}`,
    );
  },

  addServerLog,
  getServerLogs,
  getServerLogCount,
  nop: async (_: WriteTransaction) => {},
};

const flattenCache = async (
  tx: WriteTransaction,
  timestamp: number,
  letter: Letter,
) => {
  // Get all the splatters for this letter
  const splatters = (await (await tx.scan({prefix: `splatter/${letter}`}))
    .entries()
    .toArray()) as [string, Splatter][];

  // And find any splatters which are "old"
  const oldSplatters: [string, Splatter][] = splatters.filter(
    s => timestamp - s[1].t >= SPLATTER_MAX_AGE,
  );
  // Now if we have any cacheable splatters, draw them to the cache
  // Draw them on top of the last cached image
  if (oldSplatters.length === 0) {
    return;
  }
  console.log(`${letter}: Flattening ${oldSplatters.length} splatters.`);
  const [png] = await Promise.all([
    unchunk(tx, `cache/${letter}`),
    _initRenderer!(),
  ]);
  const decoded = png ? decode(png) : undefined;
  const newCache = draw_cache_png(
    decoded,
    ...splatters2Render(
      oldSplatters.map(s => s[1]),
      // When we draw a cache, we just want the "finished" state of all the
      // animations, as they're presumed to be complete and immutable.
      oldSplatters.map(() => SPLATTER_ANIM_FRAMES),
    ),
  );
  const flattenedKeys = oldSplatters.map(s => s[0]);
  await chunk(tx, `cache/${letter}`, encode(newCache));
  for await (const key of flattenedKeys) {
    await tx.del(key);
  }
};
