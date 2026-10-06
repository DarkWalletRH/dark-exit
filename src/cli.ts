#!/usr/bin/env node
// SPDX-License-Identifier: MIT OR Apache-2.0
// The command-line front door. Reads the secret from stdin or an env var, NEVER from an argument —
// arguments land in shell history and in the process list, where other users on the machine can read
// them.
import { createInterface } from 'node:readline';
import { exit as darkExit, DERIVATION_PATH } from './index.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

if (has('help') || has('h')) {
  console.log(`dark-exit — withdraw your USDG from the Dark vault without Dark.

  dark-exit [options]

Your secret is read from the DARK_SECRET environment variable, or from stdin if that
is unset. It is never accepted as a command-line argument: arguments are visible in
your shell history and to every other user on the machine.

  --chain <id>        4663 mainnet, 46630 testnet (default 46630)
  --rpc <url>         any JSON-RPC endpoint. Default: the chain's public one.
                      Nothing here talks to a Dark server, ever.
  --to <0x…>          where the USDG goes. Default: your own address.
  --amount <usdg>     a decimal amount, e.g. 12.5. Default: everything.
  --account <n>       BIP-44 index, if your wallet derived more than one (default 0)
  --dry-run           show what would happen and stop
  --help

Path: ${DERIVATION_PATH}/<n>

  export DARK_SECRET="twelve words …"   &&  dark-exit --chain 46630
  echo "0x<private key>" | dark-exit --dry-run
`);
  process.exit(0);
}

async function readSecret(): Promise<string> {
  const fromEnv = process.env.DARK_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (process.stdin.isTTY) {
    console.error('Paste your 12/24 words or private key, then press Enter.');
    console.error('(nothing is sent anywhere — the key stays on this machine)\n');
  }
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
