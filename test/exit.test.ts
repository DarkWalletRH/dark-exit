import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretToPrivateKey, DERIVATION_PATH } from '../src/index.ts';

// The canonical BIP-39 test vector. If this ever changes, someone's funds become unreachable, so it
// is pinned rather than computed.
const VECTOR = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('12 words derive the same key every mainstream wallet derives', () => {
  const key = secretToPrivateKey(VECTOR);
  assert.match(key, /^0x[0-9a-f]{64}$/);
  // m/44'/60'/0'/0/0 for this phrase — the address every Ethereum wallet shows first.
  assert.equal(key, '0x1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
  assert.equal(DERIVATION_PATH, "m/44'/60'/0'/0");
});

test('account index selects a different key, not a different phrase', () => {
  assert.notEqual(secretToPrivateKey(VECTOR, 0), secretToPrivateKey(VECTOR, 1));
  assert.equal(secretToPrivateKey(VECTOR, 1), secretToPrivateKey(VECTOR, 1));
});

test('a raw private key is accepted, with or without 0x', () => {
  const raw = 'ab'.repeat(32);
  assert.equal(secretToPrivateKey(raw), `0x${raw}`);
  assert.equal(secretToPrivateKey(`0x${raw.toUpperCase()}`), `0x${raw}`);
  assert.equal(secretToPrivateKey(`  0x${raw}  `), `0x${raw}`);
});

test('a mistyped phrase is refused rather than silently deriving the wrong account', () => {
  // One word changed: the checksum catches it. Without this check the tool would happily derive a
  // valid-looking key for an account that has never existed, and report a zero balance — which
  // someone in a panic would read as "my money is gone".
  const wrong = VECTOR.replace(/about$/, 'ability');
  assert.throws(() => secretToPrivateKey(wrong), /checksum/);

  assert.throws(() => secretToPrivateKey('too few words'), /12 or 24 words/);
  assert.throws(() => secretToPrivateKey('0xdeadbeef'), /12 or 24 words/);
});
