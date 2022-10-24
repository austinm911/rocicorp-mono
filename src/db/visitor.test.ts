import {expect} from '@esm-bundle/chai';
import * as dag from '../dag/mod';
import {ChainBuilder} from './test-helpers';
import {fakeHash, Hash} from '../hash';
import type {Entry, Node} from '../btree/node';
import type {ReadonlyJSONValue} from '../json';
import {Visitor} from './visitor';
import {Commit, Meta, newLocal} from './commit';
import {
  toInternalValue,
  InternalValue,
  ToInternalValueReason,
} from '../internal-value.js';

test('test that we get to the data nodes', async () => {
  const clientID = 'client-id';
  const dagStore = new dag.TestStore();

  const log: (readonly Entry<Hash>[] | readonly Entry<InternalValue>[])[] = [];
  const b = new ChainBuilder(dagStore);

  class TestVisitor extends Visitor {
    override async visitBTreeNodeChunk(chunk: dag.Chunk<Node>) {
      log.push(chunk.data[1]);
    }
  }

  const t = async (commit: Commit<Meta>, expected: ReadonlyJSONValue[]) => {
    log.length = 0;
    await dagStore.withRead(async dagRead => {
      const visitor = new TestVisitor(dagRead);
      await visitor.visitCommit(commit.chunk.hash);
      expect(log).to.deep.equal(expected);
    });
  };

  await b.addGenesis(clientID);
  await t(b.chain[0], [[]]);

  await b.addLocal(clientID);
  await t(b.chain[1], [[['local', '1']], []]);

  if (DD31) {
    await b.addSnapshot(undefined, clientID, undefined, undefined, {
      1: {prefix: 'local', jsonPointer: '', allowEmpty: false},
    });
    await t(b.chain[2], [[['local', '1']], [['\u00001\u0000local', '1']]]);
  } else {
    await b.addIndexChange(clientID);
    await t(b.chain[2], [[['local', '1']], [['\u00001\u0000local', '1']], []]);
  }

  await b.addLocal(clientID);
  if (DD31) {
    await t(b.chain[3], [
      [['local', '3']],
      [['\u00003\u0000local', '3']],
      [['local', '1']],
      [['\u00001\u0000local', '1']],
    ]);
  } else {
    await t(b.chain[3], [
      [['local', '3']],
      [['\u00003\u0000local', '3']],
      [['local', '1']],
      [['\u00001\u0000local', '1']],
      [],
    ]);
  }

  await b.addSnapshot([['k', 42]], clientID);
  await t(b.chain[4], [
    [
      ['k', 42],
      ['local', '3'],
    ],
    [['\u00003\u0000local', '3']],
  ]);

  await b.addLocal(clientID);
  const syncChain = await b.addSyncSnapshot(b.chain.length - 1, clientID);
  await t(syncChain[0], [
    [
      ['k', 42],
      ['local', '3'],
    ],
    [['\u00005\u0000local', '5']],
    [['\u00003\u0000local', '3']],
  ]);

  const localCommit = await dagStore.withWrite(async dagWrite => {
    const prevCommit = b.chain[b.chain.length - 1];
    const localCommit = newLocal(
      dagWrite.createChunk,
      prevCommit.chunk.hash,
      42,
      'mutname',
      toInternalValue([], ToInternalValueReason.Test),
      fakeHash('0e'),
      prevCommit.valueHash,
      prevCommit.indexes,
      88,
      clientID,
    );
    await dagWrite.putChunk(localCommit.chunk);
    await dagWrite.setHead('test', localCommit.chunk.hash);
    await dagWrite.commit();
    return localCommit;
  });
  await t(localCommit, [
    [
      ['k', 42],
      ['local', '5'],
    ],
    [['\u00005\u0000local', '5']],
    [
      ['k', 42],
      ['local', '3'],
    ],
    [['\u00003\u0000local', '3']],
  ]);

  const localCommit2 = await dagStore.withWrite(async dagWrite => {
    const prevCommit = b.chain[b.chain.length - 1];
    const localCommit2 = newLocal(
      dagWrite.createChunk,
      prevCommit.chunk.hash,
      42,
      'mutname',
      toInternalValue([], ToInternalValueReason.Test),
      localCommit.chunk.hash,
      prevCommit.valueHash,
      prevCommit.indexes,
      88,
      clientID,
    );
    await dagWrite.putChunk(localCommit2.chunk);
    await dagWrite.setHead('test2', localCommit2.chunk.hash);
    await dagWrite.commit();
    return localCommit2;
  });
  await t(localCommit2, [
    [
      ['k', 42],
      ['local', '5'],
    ],
    [['\u00005\u0000local', '5']],
    [
      ['k', 42],
      ['local', '3'],
    ],
    [['\u00003\u0000local', '3']],
  ]);
});
