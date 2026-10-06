// SPDX-License-Identifier: MIT OR Apache-2.0
// The offline exit page. Everything — bb.js, the circuits, the reference string — is bundled into
// this build, so a saved copy of the folder, served from the user's own machine, needs no network
// beyond the blockchain endpoint the user picks. That is the point: it must keep working when Dark
// does not exist. (Module scripts do not run from file://, so it is served, not double-clicked.)
import { WebDarkProver } from '@darkwalletrh/dark-sdk';
import { exit, secretToPrivateKey } from '../../src/index.js';

// Bundled as URLs so the bundler emits them as real assets rather than inlining ~12 MB of base64.
import srsG1Url from '../assets/g1.dat?url';
import srsG2Url from '../assets/g2.dat?url';
import srsMeta from '../assets/srs.json';
import registerAcir from '../assets/dark_register.json';
import transferAcir from '../assets/dark_transfer.json';
import withdrawAcir from '../assets/dark_withdraw.json';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const out = $('out');
const say = (line: string) => {
  out.textContent = `${out.textContent === 'Ready.' ? '' : `${out.textContent}\n`}${line}`;
};
const reset = () => {
  out.textContent = 'Ready.';
};

/**
 * the reference string is checked here, against the hash pinned at build time.
 *
 * A tampered reference string cannot forge anything — the deployed verifier's key is fixed, so a
 * proof built against different parameters simply fails the on-chain pairing check. What it does is
 * waste the one attempt someone gets at a moment they are already in trouble, and fail deep inside
 * bb.js or on-chain rather than here, where the message can say what actually went wrong.
 *
 * This page is designed to be saved and rehosted by anyone, so "the build verified it" is not the
 * same as "the bytes in front of this user are right".
 */
async function fetchVerified(url: string, expected: string, what: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const got = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (got !== expected) {
    throw new Error(
      `${what} does not match the hash this page was built with. ` +
        `Expected ${expected.slice(0, 12)}…, got ${got.slice(0, 12)}…. ` +
        'Re-download this page from a source you trust; do not enter your recovery phrase into it.',
    );
  }
  return bytes;
}

async function loadProver(): Promise<WebDarkProver> {
  say('Loading the prover…');
  const [g1, g2] = await Promise.all([
    fetchVerified(srsG1Url, srsMeta.g1Sha256, 'The reference string (g1)'),
    fetchVerified(srsG2Url, srsMeta.g2Sha256, 'The reference string (g2)'),
  ]);
  say('Reference string verified.');
  return new WebDarkProver({
    srs: { g1, numPoints: srsMeta.numPoints, g2 },
    circuits: {
      dark_register: registerAcir as never,
      dark_transfer: transferAcir as never,
      dark_withdraw: withdrawAcir as never,
    },
  });
}

function read() {
  const secret = $<HTMLTextAreaElement>('secret').value.trim();
  if (!secret) throw new Error('Enter your recovery phrase or private key first.');
  // Fail on a bad phrase here, before anything slow happens, and say why.
  secretToPrivateKey(secret);
  const amountText = $<HTMLInputElement>('amount').value.trim();
  if (amountText && !/^\d+(\.\d{1,6})?$/.test(amountText)) {
    throw new Error('Amount must be a number with at most 6 decimals, for example 12.5');
  }
  const [whole, frac = ''] = amountText.split('.');
  return {
    secret,
    chainId: Number($<HTMLSelectElement>('chain').value),
    rpcUrl: $<HTMLInputElement>('rpc').value.trim() || undefined,
    to: ($<HTMLInputElement>('to').value.trim() || undefined) as `0x${string}` | undefined,
    amount: amountText ? BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, '0')) : undefined,
  };
}

async function run(dryRun: boolean) {
  const check = $<HTMLButtonElement>('check');
  const go = $<HTMLButtonElement>('go');
  check.disabled = true;
  go.disabled = true;
  reset();
  try {
    const opts = read();
    const prover = dryRun ? undefined : await loadProver();
    const result = await exit({ ...opts, dryRun, ...(prover ? { prover } : {}), log: say });
    if (dryRun) {
      go.disabled = result.available + result.pending <= 0n;
      if (go.disabled) say('\nThere is nothing to withdraw from this account.');
      else say('\nIf that looks right, press Withdraw.');
    }
  } catch (e) {
    // The message only. A stack trace here could put derived material into a screenshot.
    say(`\n${(e as Error)?.message ?? 'Something went wrong.'}`);
  } finally {
    check.disabled = false;
  }
}

$('check').addEventListener('click', () => void run(true));
$('go').addEventListener('click', () => void run(false));
