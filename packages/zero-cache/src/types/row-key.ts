import {compareUTF8} from 'compare-utf8';
import type postgres from 'postgres';
import xxh from 'xxhashjs'; // TODO: Use xxhash-wasm
import {stringify, type JSONValue} from './bigint-json.js';

export type ColumnType = {typeOid: number};
export type RowKeyType = Record<string, ColumnType>;
export type RowKey = Record<string, postgres.SerializableParameter<JSONValue>>;

export type RowID = {schema: string; table: string; rowKey: RowKey};

// Aliased for documentation purposes when dealing with full rows vs row keys.
// The actual structure of the objects is the same.
export type RowType = RowKeyType;
export type RowValue = RowKey;

/**
 * Returns a normalized string suitable for representing a row key in a form
 * that can be used as a Map key.
 */
export function rowKeyString(key: RowKey): string {
  const tuples = Object.entries(key)
    .sort(([col1], [col2]) => compareUTF8(col1, col2))
    .flat();

  return stringify(tuples);
}

/**
 * A RowIDHash is a 128-bit column-order-agnostic hash of the schema, table name, and
 * column name / value tuples of a row key. It serves as a compact identifier for
 * a row in the database that:
 *
 * * is guaranteed to fit within the constraints of the CVR store (Durable Object
 *   storage keys cannot exceed 2KiB)
 * * can be used to compactly encode (and lookup) the rows of query results for CVR
 *   bookkeeping.
 *
 * The hash is encoded in `base64url`, with the maximum 128-bit value being 22 characters long.
 */
export function rowIDHash(id: RowID): string {
  const str = JSON.stringify([id.schema, id.table]) + rowKeyString(id.rowKey);

  // xxhash only computes 64-bit values. Run it on the forward and reverse string
  // to get better collision resistance.
  const forward = BigInt(xxh.h64().update(str).digest().toString());
  const backward = BigInt(xxh.h64().update(reverse(str)).digest().toString());
  const full = (forward << 64n) + backward;
  let fullHex = full.toString(16);
  if (fullHex.length % 2) {
    fullHex = '0' + fullHex;
  }
  return (
    Buffer.from(fullHex, 'hex')
      .toString('base64')
      // Emulate "base64url" (which Cloudflare does not support), to eliminate
      // problematic "/" characters in the hashes as they are used in slash-delimited
      // keys when stored in the CVR.
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '')
  );
}

function reverse(str: string): string {
  let reversed = '';
  for (let i = str.length - 1; i >= 0; i--) {
    reversed += str[i];
  }
  return reversed;
}
