import type { PushBody } from "../protocol/push.js";
import type { ClientID, ClientMap, Socket } from "../types/client-state.js";
import type { LogContext } from "../util/logger.js";
import { sendError } from "../util/socket.js";

export type Now = () => number;
export type ProcessUntilDone = () => void;

/**
 * handles the 'push' upstream message by queueing the mutations included in
 * [[body]] in the appropriate client state.
 */
export function handlePush(
  lc: LogContext,
  clients: ClientMap,
  clientID: ClientID,
  body: PushBody,
  ws: Socket,
  now: Now,
  processUntilDone: ProcessUntilDone
) {
  lc.debug?.("handling push", JSON.stringify(body));

  const client = clients.get(clientID);
  if (!client) {
    lc.info?.("client not found");
    sendError(ws, `no such client: ${clientID}`);
    return;
  }

  if (client.clockBehindByMs === undefined) {
    client.clockBehindByMs = now() - body.timestamp;
    lc.debug?.(
      "initializing clock offset: clock behind by",
      client.clockBehindByMs
    );
  }

  for (const m of body.mutations) {
    let idx = client.pending.findIndex((pm) => pm.id >= m.id);
    if (idx === -1) {
      idx = client.pending.length;
    } else if (client.pending[idx].id === m.id) {
      lc.debug?.("mutation already been queued", m.id);
      continue;
    }
    m.timestamp += client.clockBehindByMs;
    client.pending.splice(idx, 0, m);
    lc.debug?.(
      "inserted mutation, pending is now",
      JSON.stringify(client.pending)
    );
  }

  processUntilDone();
}
