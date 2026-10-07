#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
// The command-line front door. Reads the secret from stdin or an env var, NEVER from an argument —
// arguments land in shell history and in the process list, where other users on the machine can read
// them. At a terminal the secret is typed with echo off, so it never lands in the scrollback either.
import { createInterface } from 'node:readline';
import { exit as darkExit, DERIVATION_PATH } from './index.js';

const FLAGS_WITH_VALUE = new Set(['chain', 'rpc', 'to', 'amount', 'account']);
const FLAGS_BARE = new Set(['dry-run', 'help', 'h']);

// Every argument must be a flag this tool knows. A typo (`--dryrun`) must not quietly become a
// real withdrawal, and a secret pasted as an argument must not be echoed back by mistake.
const args = process.argv.slice(2);
const given = new Map<string, string | true>();
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  const name = a === '-h' ? 'h' : a.startsWith('--') ? a.slice(2) : null;
  if (name === null || !(FLAGS_WITH_VALUE.has(name) || FLAGS_BARE.has(name))) {
    console.error(`dark-exit: argument ${i + 1} is not an option this tool knows (see --help)`);
    process.exit(2);
  }
  if (FLAGS_BARE.has(name)) given.set(name, true);
  else {
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) {
      console.error(`dark-exit: --${name} needs a value`);
      process.exit(2);
    }
    given.set(name, value);
  }
}
const flag = (name: string): string | undefined => {
  const v = given.get(name);
  return typeof v === 'string' ? v : undefined;
};
const has = (name: string) => given.has(name);

if (has('help') || has('h')) {
  console.log(`dark-exit — withdraw your USDG from the Dark vault without Dark.

  dark-exit [options]

Your secret is read from the DARK_SECRET environment variable, or from stdin if that
is unset (typing is hidden at a terminal). It is never accepted as a command-line
argument: arguments are visible in your shell history and to every other user on the
machine.

  --chain <id>        4663 mainnet (default), 46630 testnet
  --rpc <url>         any JSON-RPC endpoint. Default: the chain's public one.
                      Nothing here talks to a Dark server, ever.
  --to <0x…>          where the USDG goes. Default: your own address.
  --amount <usdg>     a decimal amount, e.g. 12.5. Default: everything.
  --account <n>       BIP-44 index, if your wallet derived more than one (default 0)
  --dry-run           show what would happen and stop
  --help

Path: ${DERIVATION_PATH}/<n>

  dark-exit --dry-run                      (prompts for the secret; sends nothing)
  dark-exit                                (prompts, then withdraws everything)
  DARK_SECRET="$(cat phrase.txt)" dark-exit   (from a file; the phrase is not on the command line)
`);
  process.exit(0);
}

/** Reads one line from the terminal with echo off, so the phrase never lands in the scrollback. */
function promptHidden(): Promise<string> {
  process.stderr.write(
    'Paste your 12/24 words or private key, then press Enter. Typing is hidden.\n' +
      '(nothing is sent anywhere — the key stays on this machine)\n> ',
  );
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buf = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          cleanup();
          return reject(new Error('cancelled'));
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          return resolve(buf.trim());
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function readSecret(): Promise<string> {
  const fromEnv = process.env.DARK_SECRET;
  // Scrubbed before the prover runs: nargo and bb are child processes and would inherit it.
  delete process.env.DARK_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (process.stdin.isTTY) return promptHidden();
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (line.trim()) {
      rl.close();
      return line.trim();
    }
  }
  throw new Error('no secret given');
}

try {
  const amountFlag = flag('amount');
  const result = await darkExit({
    secret: await readSecret(),
    chainId: flag('chain') ? Number(flag('chain')) : undefined,
    rpcUrl: flag('rpc'),
    to: flag('to') as `0x${string}` | undefined,
    // Micro-units, 6 dp. Parsed as a decimal string so 12.5 does not become a float.
    amount: amountFlag ? parseUsdg(amountFlag) : undefined,
    accountIndex: flag('account') ? Number(flag('account')) : undefined,
    dryRun: has('dry-run'),
    log: (line) => console.log(line),
  });
  if (result.dryRun) console.log('\n(dry run — nothing was sent)');
  process.exit(0);
} catch (e) {
  // The message only; a stack here risks putting derived material in a terminal scrollback.
  console.error(`\ndark-exit: ${(e as Error)?.message ?? e}`);
  process.exit(1);
}

function parseUsdg(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`--amount must be a number with at most 6 decimals, got "${text}"`);
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}
