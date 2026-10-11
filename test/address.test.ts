// How an address is shown: the short form, the groups, what a screen reader
// says, and the identicon. Run with `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { addressBytes, addressGroups, identicon, IDENTICON_COLORS, IDENTICON_SIZE, shortAddress, spokenFullAddress, spokenShortAddress } from '../src/security/address.ts';

const ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

test('short form: the first four and the last four characters, never fewer', () => {
  assert.equal(shortAddress(ADDRESS), '7xKX…gAsU');
  assert.equal(shortAddress('abcdefghi'), 'abcdefghi');
});

test('groups of four, all alike, joining back to the address', () => {
  const groups = addressGroups(ADDRESS);
  assert.equal(groups[0], '7xKX');
  assert.equal(groups.at(-1), 'gAsU');
  assert.ok(groups.every((g) => g.length === 4));
  assert.equal(groups.join(''), ADDRESS);
});

test('a screen reader hears every letter with its case (base58 is case-sensitive)', () => {
  assert.equal(spokenShortAddress(ADDRESS), 'address starting 7, x, capital K, capital X, ending g, capital A, s, capital U');
  assert.match(spokenFullAddress(ADDRESS), /^group 1: 7, x, capital K, capital X; group 2: t, g, 2, capital C;/);
});

test('only a 32-byte base58 key is an address', () => {
  assert.equal(addressBytes(ADDRESS)?.length, 32);
  for (const bad of ['', 'not an address', `${ADDRESS}x`, '0OIl'.repeat(11), '1'.repeat(31)]) assert.equal(addressBytes(bad), null, bad);
});

test('identicon: the same for the same key, mirrored, never blank, one of eight colours', () => {
  const bytes = addressBytes(ADDRESS)!;
  const a = identicon(bytes);
  assert.deepEqual(identicon(bytes), a);
  assert.equal(a.cells.length, IDENTICON_SIZE * IDENTICON_SIZE);
  for (let row = 0; row < IDENTICON_SIZE; row++) {
    for (let col = 0; col < IDENTICON_SIZE; col++) {
      assert.equal(a.cells[row * IDENTICON_SIZE + col], a.cells[row * IDENTICON_SIZE + IDENTICON_SIZE - 1 - col]);
    }
  }
  const colors = new Set<number>();
  const shapes = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const icon = identicon(Keypair.generate().publicKey.toBytes());
    assert.ok(icon.cells.some(Boolean));
    assert.ok(icon.color >= 0 && icon.color < IDENTICON_COLORS);
    colors.add(icon.color);
    shapes.add(icon.cells.map(Number).join(''));
  }
  assert.equal(colors.size, IDENTICON_COLORS);
  assert.ok(shapes.size > 190, 'patterns tell keys apart');
  // An all-zero pattern still draws something.
  assert.ok(identicon(new Uint8Array(32)).cells.some(Boolean));
});
