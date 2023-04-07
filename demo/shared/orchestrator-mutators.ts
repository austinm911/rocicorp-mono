import type {WriteTransaction} from '@rocicorp/reflect';
import {
  ACTIVITY_TIMEOUT,
  BOT_RANDOM_LOCATIONS,
  BOT_RANDOM_SEED,
  COLOR_PALATE,
  MAX_CLIENT_BROADCASTS,
  MAX_CONCURRENT_BOTS,
  ROOM_MAX_ACTORS,
} from './constants';
import {Cursor, Env, Actor, RoomRecording} from './types';
import {string2Uint8Array} from './uint82b64';
import {
  cursorToRecordingCursor,
  nextNumber,
  randomWithSeed,
  sortableKeyNum,
} from './util';

export const ROOM_ID_KEY = 'current-room-id';
export const ROOM_COUNT_KEY = 'current-room-count';
export const COLOR_INDEX_KEY = 'color-index';

const RECORDING_RANDOM_SEED = 9438;

let env = Env.CLIENT;
let newRoomSecret: Uint8Array | undefined;
export const setEnv = (e: Env, secret?: Uint8Array) => {
  env = e;
  if (secret) {
    newRoomSecret = secret;
  }
};

export const orchestratorMutators = {
  alive: async (tx: WriteTransaction, timestamp: number) => {
    await tx.put(`alive/${tx.clientID}`, timestamp);
    const recordings = (await tx
      .scan({prefix: 'room-recordings/'})
      .values()
      .toArray()) as RoomRecording[];
    let broadcastingCount = 0;
    for (const recording of recordings) {
      if (recording.broadcasterId === tx.clientID) {
        // Don't broadcast more than N bots at a time, as it can impact performance.
        if (++broadcastingCount > MAX_CLIENT_BROADCASTS) {
          return;
        }
      }
    }
    // We just chose a random number here, I don't know how probable this is, or how
    // to adjust probability more granularly than just making the number an order of
    // magnitude larger or prime.
    if (
      recordings.length < MAX_CONCURRENT_BOTS &&
      timestamp % BOT_RANDOM_SEED === 0
    ) {
      const actor = (await tx.get(`actor/${tx.clientID}`)) as Actor;
      await playRandomRecording(tx, actor.room, actor.id, timestamp);
    }
    // We also need to periodically clean up old users - do it randomly here too
    if (timestamp % 4) {
      await cleanupOldUsers(tx, timestamp);
    }
  },
  updateActorLocation: async (tx: WriteTransaction, location: string) => {
    const key = `actor/${tx.clientID}`;
    const actor = ((await tx.get(key)) as Actor | undefined) || {
      id: tx.clientID,
    };
    await tx.put(key, {...actor, location});
  },
  removeActor: async (
    tx: WriteTransaction,
    {clientID, timestamp}: {clientID: string; timestamp: number},
  ) => {
    // This mutator is also called when clients disconnect from non-orchestrator
    // rooms, so if we don't have an actor for this client, just ignore it.
    if (await tx.has(`actor/${clientID}`)) {
      serverLog(`Orchestrator client ${clientID} left, cleaning up.`);
      await removeActor(tx, clientID, timestamp);
    }
  },
  createActor: async (
    tx: WriteTransaction,
    args: {
      fallbackRoomId: string;
      lastRoom: string | null;
      lastColorIndex: number | null;
      forceNewRoomWithSecret: string | null;
      timestamp: number;
    },
  ) => {
    // We can't create actors/rooms on the client, because otherwise we'll get a
    // local room ID which we'll create, then the server will tell us a different
    // one that we'll need to connect to instead.
    if (env === Env.CLIENT) {
      return;
    }
    await createActor(tx, {...args, isBot: false});
  },
  finishRecording: async (
    tx: WriteTransaction,
    {
      recordingId,
      roomId,
      botId,
      timestamp,
    }: {recordingId: string; roomId: string; botId: string; timestamp: number},
  ) => {
    serverLog(`Delete broadcast room-recordings/${roomId}/${recordingId}.`);
    const recording = (await tx.get(
      `room-recordings/${roomId}/${recordingId}`,
    )) as RoomRecording;
    if (recording) {
      await tx.del(`broadcaster/${recording.broadcasterId}/${recordingId}`);
      await tx.del(`controlled-bots/${recording.broadcasterId}/${botId}`);
      await tx.del(`room-recordings/${roomId}/${recordingId}`);
      await removeActor(tx, botId, timestamp);
    }
  },
  deleteRecording: async (tx: WriteTransaction, recordingId: string) => {
    // TODO: permissions/secret
    const recordingKeys = await tx
      .scan({prefix: `recordings/${recordingId}`})
      .keys();
    for await (const k of recordingKeys) {
      await tx.del(k);
    }
    await tx.del(`current-recording-frame/${recordingId}`);
    let index = ((await tx.get(`recordings-index`)) as string[]) || [];
    // O(n) but also we've got bigger problems if this gets too big to scan.
    index = index.filter(r => r !== recordingId);
    await tx.put(`recordings-index`, index);
  },
  playRecording: async (
    tx: WriteTransaction,
    {
      roomId,
      recordingId,
      timestamp,
    }: {roomId: string; recordingId: string; timestamp: number},
  ) => {
    // TODO: permissions/secret
    await playRecording(tx, roomId, recordingId, tx.clientID, timestamp);
  },
  addCursorRecording: async (
    tx: WriteTransaction,
    {
      recordingId,
      cursor,
    }: {
      recordingId: string;
      cursor: Cursor;
    },
  ) => {
    const recordingNumber = nextNumber(
      (await tx.get(`current-recording-frame/${recordingId}`)) as number,
    );
    await tx.put(
      `recordings/${recordingId}/${sortableKeyNum(recordingNumber)}`,
      cursorToRecordingCursor(cursor),
    );
    await tx.put(`current-recording-frame/${recordingId}`, recordingNumber);
    let index = [...(((await tx.get(`recordings-index`)) as string[]) || [])];
    // O(n) but also we've got bigger problems if this gets too big to scan.
    if (!index.includes(recordingId)) {
      index.push(recordingId);
      await tx.put(`recordings-index`, index);
    }
  },
};

const serverLog = (...args: any[]) => {
  if (env === Env.SERVER) {
    console.log(...args);
  }
};

const cleanupOldUsers = async (tx: WriteTransaction, timestamp: number) => {
  const alives = (await tx.scan({prefix: 'alive/'}).entries().toArray()) as [
    string,
    number,
  ][];
  const actorsToRemove: string[] = [];
  const aliveIds: Set<string> = new Set();
  for await (const [key, lastPing] of alives) {
    const id = key.split('/')[1];
    aliveIds.add(id);
    if (timestamp - lastPing > ACTIVITY_TIMEOUT) {
      actorsToRemove.push(id);
    }
  }
  if (actorsToRemove.length > 0) {
    console.log('Removing actors due to inactivity:', actorsToRemove);
  }
  for (const actorId of actorsToRemove) {
    await removeActor(tx, actorId, timestamp, actorsToRemove);
  }
};

const createActor = async (
  tx: WriteTransaction,
  {
    fallbackRoomId,
    actorId,
    isBot,
    lastRoom,
    lastColorIndex,
    controller,
    location,
    forceNewRoomWithSecret,
    timestamp,
  }: {
    fallbackRoomId: string | null;
    actorId?: string;
    isBot: boolean;
    lastRoom: string | null;
    lastColorIndex?: number | null;
    controller?: string;
    location?: string;
    forceNewRoomWithSecret?: string | null;
    timestamp: number;
  },
) => {
  actorId = actorId || tx.clientID;
  serverLog(`Orchestrator creating ${actorId}`);
  const key = `actor/${actorId}`;
  const hasActor = await tx.has(key);
  // Find the room we're currently filling
  const roomCount = (await tx.get(ROOM_COUNT_KEY)) as number | undefined;
  const existingRoom = (await tx.get(ROOM_ID_KEY)) as string | undefined;
  let selectedRoomId: string;
  let forceNewRoom = false;
  if (forceNewRoomWithSecret) {
    if (await isResetRoomSecret(forceNewRoomWithSecret)) {
      forceNewRoom = true;
    } else {
      console.warn(
        newRoomSecret
          ? `Attempted to reset room with invalid secret ${forceNewRoomWithSecret}.`
          : 'Attempted to reset room but secret is unset.',
      );
    }
  }
  // Must be set by all branches below.
  let roomActorNum: number;
  let actor: Actor;
  if (!hasActor) {
    if (
      forceNewRoom ||
      existingRoom === undefined ||
      (roomCount && roomCount >= ROOM_MAX_ACTORS)
    ) {
      if (!fallbackRoomId) {
        throw new Error(
          'Invariant violated: cannot create a new room without a fallback ID.',
        );
      }
      // Make a new room for this user and start adding users to it
      console.log('Creating new room', fallbackRoomId);
      selectedRoomId = fallbackRoomId;
      await tx.put(ROOM_ID_KEY, selectedRoomId);
      await tx.put(ROOM_COUNT_KEY, 1);
      roomActorNum = 1;
    } else if (lastRoom && lastRoom !== existingRoom) {
      // When we have a prior room and the new room has changed (likely due to being offline then reconnecting).
      // Keep us there so we don't see weird paint jumping.
      // This works because old rooms are never purged. If we start purging them, we
      // may need to rethink this (e.g. just show a clear or something)
      console.log(`User reconnected to old room ${lastRoom}`);
      // Subtle: we expect that lastColorIndex will always be set if lastRoom is set.
      // If not, we'll cause the main room to skip a color.
      selectedRoomId = lastRoom;
      // We don't know, so we just trigger a bot for now.
      roomActorNum = 1;
    } else {
      selectedRoomId = (await tx.get(ROOM_ID_KEY)) as string;
      roomActorNum = (roomCount || 0) + 1;
      await tx.put(ROOM_COUNT_KEY, roomActorNum);
    }
    // Create an index entry so we can look up users by room
    await tx.put(`actors/${selectedRoomId}/${actorId}`, actorId);
    let colorIndex = lastColorIndex;
    if (colorIndex === null || colorIndex === undefined) {
      // NOTE: we just cycle through colors, so if COLOR_PALATE.length <
      // ROOM_MAX_ACTORS, we'll see cycling duplicates.
      // We do this independently of room count, because that way if someone enters
      // and leaves, each new user will still have a distinct color from the last N users.
      const nextColorNum =
        (((await tx.get(COLOR_INDEX_KEY)) as number) || 0) + 1;
      colorIndex = nextColorNum % COLOR_PALATE.length;
      await tx.put(COLOR_INDEX_KEY, nextColorNum);
    }
    await tx.put(`alive/${actorId}`, timestamp);
    actor = {
      id: actorId,
      colorIndex,
      room: selectedRoomId,
      isBot,
      botController: controller || null,
      location: location || null,
    };
    await tx.put(key, actor);
  } else {
    // already exists
    serverLog(`${actorId} already exists.`);
    selectedRoomId = (await tx.get(ROOM_ID_KEY)) as string;
    roomActorNum = (await tx.get(ROOM_COUNT_KEY)) as number;
    actor = (await tx.get(key)) as Actor;
  }
  serverLog(
    `Current room: ${selectedRoomId}\nActors:\n${await (
      await tx
        .scan({prefix: `actors/${selectedRoomId}`})
        .values()
        .toArray()
    )
      .map(a => `${a}`)
      .join('\n')}`,
  );
  return actor;
};

const removeActor = async (
  tx: WriteTransaction,
  actorId: string,
  timestamp: number,
  alsoRemoving: string[] = [],
) => {
  const key = `actor/${actorId}`;
  console.log(`Remove orchestrator actor ${actorId}`);
  // Remove any recordings this actor was broadcasting
  const recordings = (await tx
    .scan({prefix: `broadcaster/${actorId}`})
    .entries()
    .toArray()) as [string, string][];
  for await (const [key, recordingSuffix] of recordings) {
    serverLog(`Delete broadcast room-recordings/${recordingSuffix}.`);
    await tx.del(`room-recordings/${recordingSuffix}`);
    await tx.del(key);
  }
  // Remove any bots we control
  const bots = (await tx
    .scan({prefix: `controlled-bots/${actorId}`})
    .entries()
    .toArray()) as [string, string][];
  for await (const [key, botId] of bots) {
    serverLog(`Delete bot ${botId}.`);
    await removeActor(tx, botId, timestamp, [actorId, ...alsoRemoving]);
    await tx.del(key);
  }
  await tx.del(`alive/${actorId}`);

  const actor = (await tx.get(key)) as Actor;
  // Dunno who that is
  if (!actor) {
    return;
  }
  // Delete the actor and the index entry for them
  await tx.del(key);
  await tx.del(`actors/${actor.room}/${actorId}`);

  const currentRoom = (await tx.get(ROOM_ID_KEY)) as string;
  if (!currentRoom || actor.room !== currentRoom) {
    // The room that the actor was in doesn't exist, no need to do any more.
    console.log('Actor from old room');
    return;
  }
  // Decrement the room count, so that as long as we don't hit the ceiling, we'll
  // always use the same room.
  const roomCount = (await tx.get(ROOM_COUNT_KEY)) as number;
  if (!roomCount || roomCount < 0) {
    console.error("Can't remove an actor from an empty room...");
    return;
  }
  await tx.put(ROOM_COUNT_KEY, roomCount - 1);
};

const playRandomRecording = async (
  tx: WriteTransaction,
  roomId: string,
  broadcasterId: string,
  timestamp: number,
) => {
  const recordings = (await tx.get(`recordings-index`)) as string[];
  if (!recordings || !recordings.length) {
    console.log('Asked to start a recording, but there were none.');
    return;
  }
  const recordingIdx = Math.floor(
    randomWithSeed(timestamp, RECORDING_RANDOM_SEED, recordings.length),
  );
  const recordingId = recordings[recordingIdx] + `@${timestamp}`;
  return await playRecording(tx, roomId, recordingId, broadcasterId, timestamp);
};

const RANDOM_LOCATION_SEED = 239;
const playRecording = async (
  tx: WriteTransaction,
  roomId: string,
  recordingId: string,
  broadcasterId: string,
  timestamp: number,
) => {
  if (!recordingId) {
    throw new Error('hi');
  }
  // 8 bits of entropy is enough.
  const botId = broadcasterId.slice(0, 8) + `-${timestamp}-bot`;
  const bot = await createActor(tx, {
    fallbackRoomId: null,
    // Always make the bot in the same room as the controller
    lastRoom: roomId,
    actorId: botId,
    isBot: true,
    controller: broadcasterId,
    location:
      BOT_RANDOM_LOCATIONS[
        Math.floor(
          randomWithSeed(
            timestamp,
            RANDOM_LOCATION_SEED,
            BOT_RANDOM_LOCATIONS.length,
          ),
        )
      ],
    timestamp,
  });
  serverLog(`create bot ${botId}`, bot, bot.colorIndex);
  await tx.put(`controlled-bots/${broadcasterId}/${botId}`, botId);
  const recording: RoomRecording = {
    roomId,
    broadcasterId: broadcasterId,
    botId,
    recordingId,
    colorIdx: bot.colorIndex,
  };
  await tx.put(`room-recordings/${roomId}/${recordingId}`, recording);
  await tx.put(
    `broadcaster/${broadcasterId}/${recordingId}`,
    `${roomId}/${recordingId}`,
  );
  return recording;
};

const isResetRoomSecret = async (secret: string) => {
  if (!newRoomSecret) {
    return false;
  }
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    string2Uint8Array(secret),
  );
  if (buffer.byteLength !== newRoomSecret.byteLength) {
    return false;
  }
  const view = new Uint8Array(buffer);
  for (const idx in newRoomSecret) {
    if (view[idx] !== newRoomSecret[idx]) {
      return false;
    }
  }
  return true;
};
