<div align="center">

<img src=".github/assets/logo.png" alt="Dark" width="112" />

# Dark Exit

**Withdraw your USDG from the Dark vault with every Dark server switched off.**

[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-f5a0c4?style=flat-square)](#license)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/DarkWalletRH/dark-exit/ci.yml?branch=main&style=flat-square&label=CI)](.github/workflows/ci.yml)
[![Status: pre-audit](https://img.shields.io/badge/status-pre--audit-orange?style=flat-square)](#status)

[Website](https://darkwallet.cash) · [Whitepaper](https://darkwallet.cash/whitepaper) · [Docs](https://darkwallet.cash/docs) · [SDK](https://github.com/DarkWalletRH/dark-sdk) · [Contracts](https://github.com/DarkWalletRH/dark-contracts) · [Starter template](https://github.com/DarkWalletRH/Darkwallet)

</div>

---

## Overview

Dark Exit is the emergency withdrawal tool for Dark. It moves your USDG out of the Dark vault using
only two things: **your recovery phrase** and **a JSON-RPC endpoint of your choosing**. It does not
use Dark's API, relay, website or any other Dark-operated service, so it keeps working if all of
them are offline, permanently.

That is possible because everything a withdrawal needs is public or derivable from your key: the
encrypted balance and the account's transfers are on chain, the circuits are open source, and the
decryption and signing keys derive from your phrase. Dark Exit reads the account from the chain,
proves the withdrawal on your own device and sends the transaction itself.

It ships in two forms:

| Form | For | Needs |
|---|---|---|
| **Offline page** | Anyone. Open it in a browser, enter the phrase, withdraw. | A modern browser and a local static file server, such as Python's built-in one. |
| **Command-line tool** | Developers and operators, scripted or audited use. | Node.js 22, `nargo` and `bb` for proving. |

> [!NOTE]
> The vault's `withdraw`, `applyPending` and `register` functions cannot be paused by anyone,
> including Dark. A withdrawal is an ordinary public USDG transfer: the destination address and the
> amount withdrawn are visible on chain.

## How it works

1. **Derive the key.** A 12- or 24-word BIP-39 phrase is derived along `m/44'/60'/0'/0/n`, the
   standard Ethereum path used by mainstream wallets. A raw 32-byte private key is also accepted.
   The page always uses the first address (`n = 0`); the command-line tool selects another with
   `--account`.
2. **Read the account from the chain.** Registration, the encrypted balance and any pending
   incoming transfers are read directly from the vault through your endpoint.
3. **Recover the balance.** The available balance is opened from its sealed balance hint, which is
   checked against the on-chain ciphertext before it is trusted. Pending transfers are opened from
   each transfer's own hint, checked the same way. If a hint is missing or wrong, the amount is
   recovered by a search bounded by the vault's total holdings, so a corrupted hint or a hostile
   sender cannot strand the funds.
4. **Apply pending transfers.** Incoming transfers are not spendable until they are folded into the
   available balance. Dark Exit does this automatically before withdrawing.
5. **Prove and send.** The withdrawal proof is generated on your device and the transaction is
   signed locally and broadcast through your endpoint. The recipient address is bound into the
   proof, so no intermediary can redirect the funds.

The account pays gas in ETH on Robinhood Chain. If it holds none, send a small amount of ETH to the
account before withdrawing.

## Offline page

`web/` builds a single static folder that performs the complete exit in the browser. Everything is
bundled into it: the prover (Barretenberg and the Noir ACVM, as WebAssembly), the three circuits and
the 8 MiB reference string. At runtime the page contacts nothing except the endpoint you select.

### Use a release

Each [release](https://github.com/DarkWalletRH/dark-exit/releases) provides the page as an archive
of the `dist-web/` folder, together with `SHA256SUMS`, the SHA-256 of every file in it. Verify
before use:

```bash
cd dist-web                # the extracted release folder
find . -type f | LC_ALL=C sort | xargs shasum -a 256 > ../SHA256SUMS.local
diff ../SHA256SUMS.local ../SHA256SUMS && echo "verified"
```

On Linux, `sha256sum` produces identical output to `shasum -a 256`.

Serve the folder from any static file server and open it. Browsers do not run module scripts from
`file://` URLs, so a local server is required:

```bash
python3 -m http.server 8080 --bind 127.0.0.1    # then open http://127.0.0.1:8080
```

Proving runs multithreaded when the server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, and single-threaded otherwise. Both work; the threaded
build is faster.

### Build it reproducibly

The page is a deterministic function of three inputs, each pinned by hash. A rebuild from the same
release tags produces byte-identical output, which you can compare with the release's `SHA256SUMS`.

| Input | Source | Pinned by |
|---|---|---|
| Circuits | `dark-contracts/circuits`, compiled with `nargo` 1.0.0-beta.22 | ACIR SHA-256 in `circuits/manifest.json` |
| Reference string | The first 2<sup>17</sup> points of the public BN254 setup | SHA-256 in `circuits/srs/MANIFEST.json` |
| JavaScript dependencies | npm, including the SDK at its release tag | `package-lock.json` |

```bash
# 1. The pinned Noir compiler
noirup --version 1.0.0-beta.22

# 2. The circuits, compiled from the contracts repository
git clone --depth 1 --branch v1.0.4 https://github.com/DarkWalletRH/dark-contracts.git
(cd dark-contracts/circuits && nargo compile)

# 3. The reference string (8 MiB of G1 points and the G2 point)
curl -fsSL -r 0-8388607 https://crs.aztec-cdn.foundation/g1.dat | head -c 8388608 > dark-contracts/circuits/srs/g1.dat
curl -fsSL https://crs.aztec-cdn.foundation/g2.dat > dark-contracts/circuits/srs/g2.dat

# 4. The page
git clone --branch v1.0.2 https://github.com/DarkWalletRH/dark-exit.git
cd dark-exit
npm ci
DARK_CIRCUITS_SRC="$PWD/../dark-contracts/circuits" npm run web:build    # writes dist-web/

# 5. Compare with the release
(cd dist-web && find . -type f | LC_ALL=C sort | xargs shasum -a 256) > SHA256SUMS.local
diff SHA256SUMS.local /path/to/release/SHA256SUMS && echo "reproduced"
```

`npm run web:build` checks every circuit against `manifest.json` and both reference-string files
against their pins before bundling, and fails on any mismatch rather than producing a page that
cannot prove. The page checks the reference string's SHA-256 again in the browser before it proves,
so a copy whose parameters were altered after the build refuses to withdraw.

For local development, `npm run web:dev` (with the same `DARK_CIRCUITS_SRC`) serves the page with
the cross-origin isolation headers.

### What the bundle contains

The page is a static bundle, and every URL in it can be listed with
`grep -rhoE 'https?://[a-zA-Z0-9.-]+' dist-web | sort -u`. Besides the two default RPC endpoints,
the list contains the two block explorers from the SDK's deployment record, which are never
contacted, and constants carried by the bundled libraries: viem's documentation links, signature
lookup service and name-service gateways, and Barretenberg's reference-string CDN, which goes
unused because the page supplies the bundled reference string. The string `darkwallet.cash` appears
twice: as the default origin the SDK uses when composing a disclosure link, and as a
domain-separation tag inside the cryptography. Neither is ever requested.

To confirm this for yourself, open the browser's network inspector: after the page has loaded, the
only requests are to the page's own origin and to the selected endpoint.

## Command-line tool

### Install

```bash
git clone --branch v1.0.2 https://github.com/DarkWalletRH/dark-exit.git
cd dark-exit
npm ci
npm run build          # tsc → dist/
```

`--dry-run` needs nothing further. To prove a withdrawal, the CLI drives the native Noir toolchain
against the circuits from the contracts repository:

```bash
noirup --version 1.0.0-beta.22
bbup --version 5.0.0-nightly.20260522
git clone --depth 1 --branch v1.0.4 https://github.com/DarkWalletRH/dark-contracts.git ../dark-contracts
export DARK_CIRCUITS_DIR="$PWD/../dark-contracts/circuits"
```

The circuits are compiled and their verification keys derived on first use. `DARK_NARGO` and
`DARK_BB` override the binaries' locations. On its first run, `bb` downloads the public reference
string into `~/.bb-crs` unless it is already cached; that request goes to the toolchain's CDN, not
to Dark.

### Run

```bash
node dist/cli.js --dry-run    # prompts for the phrase (typing is hidden), reads the account, shows the plan
node dist/cli.js              # the same, then applies pending transfers, proves and withdraws
```

The secret is read from the `DARK_SECRET` environment variable or, when that is unset, from
standard input (at a terminal the prompt hides what you type). It is never accepted as a
command-line argument, because arguments are recorded in shell history and are visible to other
users in the process list. Unknown arguments are refused rather than ignored.

| Option | Meaning |
|---|---|
| `--chain <id>` | `4663` (mainnet, the default) or `46630` (testnet). |
| `--rpc <url>` | Any JSON-RPC endpoint. Default: the chain's public endpoint. |
| `--to <0x…>` | Destination address. Default: the account's own address. |
| `--amount <n>` | A decimal USDG amount with at most 6 decimals, for example `12.5`. Default: the full available balance. |
| `--account <n>` | The index *n* in `m/44'/60'/0'/0/n`, for a wallet that derived more than one address. The second address in most wallets is `1`. Default: `0`. |
| `--dry-run` | Read the account and print the plan. Sends nothing. |
| `--help` | Print usage. |

The tool prints the derived account, chain, endpoint and vault address before it acts. Compare the
vault address with the table under [Networks](#networks). It exits with status `0` on success and
`1` on any error, printing the error message only.

The same flow is available as a library: `exit(options)` and `secretToPrivateKey(secret, index)`
are exported from `dist/index.js`.

## Handling your recovery phrase

Your recovery phrase controls your funds. Anyone who learns it can take them, with or without Dark.

- **Obtain Dark Exit only from this repository.** Verify a release against its `SHA256SUMS`, or
  build it yourself as described above. Never enter your phrase into a copy sent to you by someone
  else, however it is presented.
- **Dark will never ask for your recovery phrase**, by email, chat, support ticket or any other
  channel. A request for it is an attempt to steal your funds.
- **Use a device you trust.** Avoid shared or public computers. Close other browser tabs and
  extensions you do not need while the page is open.
- **Keep it out of persistent storage.** Do not paste the phrase into a command line, a file, a
  chat or a notes application. With the CLI, let the tool prompt you (typing is hidden) or pipe the
  phrase on standard input; if you do export `DARK_SECRET`, `unset` it afterwards.
- **Check before you withdraw.** Run `--dry-run`, or *Check my balance* on the page, and confirm
  the account address and balance before sending anything.
- **Choose the destination deliberately.** By default the funds return to the account's own
  address. A withdrawal to another address is public and permanent.

### What your endpoint can and cannot do

The endpoint never receives your phrase or your private key; it receives only signed transactions
and read requests. It can observe your IP address and which account you query. A dishonest
endpoint can refuse service, withhold your transaction or report incorrect state, which can make a
withdrawal fail or a displayed balance wrong. It cannot redirect funds: the vault address is built
into the tool, the destination is bound into the proof and the transaction is signed on your device. If the privacy of the query matters to you, use your own node or a provider you trust.

## Networks

| Network | Chain ID | Default endpoint | Vault |
|---|---|---|---|
| Robinhood Chain mainnet | `4663` | `https://rpc.mainnet.chain.robinhood.com` | [`0xeD7a0c6899a6AC94Aea7A5b2F8f24a948042DA9C`](https://robinhoodchain.blockscout.com/address/0xeD7a0c6899a6AC94Aea7A5b2F8f24a948042DA9C) |
| Robinhood Chain testnet | `46630` | `https://rpc.testnet.chain.robinhood.com` | [`0x14fa77C25357C1Dc7de0DD7F36e0EbE807110aB7`](https://explorer.testnet.chain.robinhood.com/address/0x14fa77C25357C1Dc7de0DD7F36e0EbE807110aB7) |

Addresses come from the deployment record in [`dark-sdk`](https://github.com/DarkWalletRH/dark-sdk).
[`dark-contracts`](https://github.com/DarkWalletRH/dark-contracts) rebuilds the contracts deployed at
them from source and checks the result against their on-chain bytecode.

## Development

```bash
npm ci
npm run build    # tsc → dist/
npm test         # node:test via tsx
```

The tests pin key derivation to the canonical BIP-39 test vector, so a change that would derive a
different account from the same phrase fails the suite. They also cover raw-key input and the
rejection of a mistyped phrase by its checksum.

## Status

Version 1.0.2. The contracts Dark Exit targets are **pre-audit** and run under launch caps; see
[`dark-contracts`](https://github.com/DarkWalletRH/dark-contracts) for the current state.

## Security

Please report vulnerabilities privately to **team@darkwallet.cash**. Do not open a public issue.
Include the Dark Exit version, the form (page or command-line tool), the chain and, where possible,
a reproduction. If Dark Exit ever requires a Dark server to complete a withdrawal, that is a defect
of the highest severity. See
[darkwallet.cash/.well-known/security.txt](https://darkwallet.cash/.well-known/security.txt).

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Unless you explicitly state otherwise, any contribution intentionally submitted for
inclusion in this work shall be dual-licensed as above, without any additional terms or conditions.
