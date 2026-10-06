// SPDX-License-Identifier: MIT OR Apache-2.0
// dark-exit: withdraw your USDG from the Dark vault with Dark switched off.
//
// This exists so that "you keep custody" is a testable claim rather than a promise. It talks to
// ONE thing — an Ethereum JSON-RPC endpoint, which you choose — and to nothing of Dark's. No API,
// no relay, no website, no telemetry. If every server Dark runs disappeared tonight, this still
// moves your money out, because everything it needs is on chain and in your own key.
//
// It deliberately has no dependency on `@darkwalletrh/dark-sdk`'s network paths beyond the chain
// client, and the whole package is MIT OR Apache-2.0 so it can be republished from the public
// mirror by anyone who wants to check it.
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils';
import { LiveDarkClient, deployments, isDeployed, type DarkProver } from '@darkwalletrh/dark-sdk';

// NodeDarkProver is imported lazily and ONLY when no prover was supplied: it reaches for node:fs and
// child_process, which would drag Node-only code into the browser build of this same module. The
// offline exit page passes a WebDarkProver instead.
async function defaultProver(): Promise<DarkProver> {
  const { NodeDarkProver } = await import('@darkwalletrh/dark-sdk');
  return new NodeDarkProver();
}

export type Hex = `0x${string}`;

/** Where the funds go. Defaults to the account's own address, which is almost always what you want. */
export interface ExitOptions {
  /** 12 or 24 BIP-39 words, or a raw 0x-prefixed secp256k1 key. Never logged, never sent anywhere. */
  secret: string;
  chainId?: number;
  /** ANY JSON-RPC endpoint. Defaults to the chain's public one — never a Dark-operated URL. */
  rpcUrl?: string;
  /** BIP-44 account index, for a wallet that derived more than one. */
  accountIndex?: number;
  /** Where to send the USDG. Defaults to your own address. */
  to?: Hex;
  /** Withdraw less than everything. Micro-units (6 dp). Defaults to the whole balance. */
  amount?: bigint;
  /** Print what it would do and stop. */
  dryRun?: boolean;
  prover?: DarkProver;
  log?: (line: string) => void;
}

export interface ExitResult {
  account: Hex;
  available: bigint;
  pending: bigint;
  pendingCount: number;
  appliedPending: Hex | null;
  withdrawn: bigint;
  withdrawTx: Hex | null;
  to: Hex;
  dryRun: boolean;
}

/** The standard Ethereum path. The same one every mainstream wallet uses, so a seed phrase from one works here. */
export const DERIVATION_PATH = "m/44'/60'/0'/0";

/**
 * Turn 12/24 words or a raw key into the private key. Accepts a raw key too, because someone whose
 * wallet is gone may have exported a key rather than a phrase, and this tool exists for exactly the
 * situation where the convenient option is unavailable.
 */
export function secretToPrivateKey(secret: string, accountIndex = 0): Hex {
  const trimmed = secret.trim();

  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase() as Hex;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed.toLowerCase()}` as Hex;

  const words = trimmed.split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`expected 12 or 24 words, or a 32-byte hex key — got ${words.length} words`);
  }
  const phrase = words.join(' ').toLowerCase();
  if (!validateMnemonic(phrase, wordlist)) {
    // Almost always a typo or a wrong word order; the checksum is what catches it.
    throw new Error('that recovery phrase is not valid (the checksum does not match)');
  }
  const node = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive(`${DERIVATION_PATH}/${accountIndex}`);
  if (!node.privateKey) throw new Error('could not derive a private key from that phrase');
  return `0x${bytesToHex(node.privateKey)}` as Hex;
}

/**
 * Read the account, fold in anything pending, and withdraw.
 *
 * The balance is recovered the way §6.7 step 5 describes: the sealed `aeBalance` first, then a
 * replay of the account's own history, then a bounded brute-force search. Each is a fallback for
 * the one before, so a corrupted hint or a hostile sender cannot strand the funds.
 */
export async function exit(opts: ExitOptions): Promise<ExitResult> {
  const chainId = opts.chainId ?? 46630;
  const say = opts.log ?? (() => {});

  if (!isDeployed(chainId)) {
    throw new Error(`DARK-CB-1 is not deployed on chain ${chainId}, so there is nothing to withdraw from`);
  }
  const deployment = deployments[chainId]!;
  const rpcUrl = opts.rpcUrl ?? deployment.rpcUrl;

  const privateKey = secretToPrivateKey(opts.secret, opts.accountIndex ?? 0);
  const { privateKeyToAccount } = await import('viem/accounts');
  const account = privateKeyToAccount(privateKey).address as Hex;

  say(`account  ${account}`);
  say(`chain    ${chainId}`);
  say(`rpc      ${rpcUrl}`);
  say(`vault    ${deployment.vault}`);

  const client = await LiveDarkClient.create({
    chainId,
    account,
    privateKey,
    rpcUrl,
    prover: opts.prover ?? (await defaultProver()),
    // No `api`: this tool must work when every server Dark runs is gone.
  });

  const snapshot = await client.sync();
  if (!snapshot.registryKey) {
    throw new Error('this account is not registered with the vault, so it holds no private balance');
  }

  let balances = await client.getBalances(snapshot);
  say(`available ${usdg(balances.available)}`);
  say(`pending   ${usdg(balances.pending)} across ${balances.pendingCount} transfer(s)`);

  const result: ExitResult = {
    account,
    available: balances.available,
    pending: balances.pending,
    pendingCount: Number(balances.pendingCount),
    appliedPending: null,
    withdrawn: 0n,
    withdrawTx: null,
    to: opts.to ?? account,
    dryRun: Boolean(opts.dryRun),
  };

  if (opts.dryRun) {
    say(`\nwould apply ${balances.pendingCount} pending transfer(s) and withdraw ${usdg(balances.available + balances.pending)} to ${result.to}`);
    result.withdrawn = balances.available + balances.pending;
    return result;
  }

  // Pending first: an incoming transfer is not spendable until it is folded into `available`, and
  // this is the step a stranded user most often does not know about.
  if (Number(balances.pendingCount) > 0) {
    say(`\napplying ${balances.pendingCount} pending transfer(s)…`);
    result.appliedPending = (await client.applyPending()) as Hex;
    say(`  ${result.appliedPending}`);
    balances = await client.getBalances();
    say(`available ${usdg(balances.available)}`);
  }

  const amount = opts.amount ?? balances.available;
  if (amount <= 0n) {
    say('\nnothing to withdraw');
    return result;
  }
  if (amount > balances.available) {
    throw new Error(`asked to withdraw ${usdg(amount)} but only ${usdg(balances.available)} is available`);
  }

  say(`\nproving withdrawal of ${usdg(amount)} to ${result.to}…`);
  result.withdrawTx = (await client.withdraw(amount, result.to, (f, stage) => {
    if (stage) say(`  ${stage} ${Math.round(f * 100)}%`);
  })) as Hex;
  result.withdrawn = amount;
  say(`  ${result.withdrawTx}`);
  say(`\ndone — ${usdg(amount)} sent to ${result.to}`);

  return result;
}

const usdg = (v: bigint): string => `${(Number(v) / 1e6).toFixed(6)} USDG`;
