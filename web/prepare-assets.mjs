// Copy the circuits and the pinned SRS into the web build, verifying every hash on the way.
//
// Nothing here is fetched at runtime, so whatever this script copies is what the page will prove
// with for ever. A wrong or stale artifact must fail HERE, loudly, rather than produce proofs that
// the deployed verifiers reject when someone is already trying to rescue their funds.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CIRCUITS = process.env.DARK_CIRCUITS_SRC ?? join(HERE, '..', '..', '..', 'circuits');
const OUT = join(HERE, 'assets');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const manifest = JSON.parse(readFileSync(join(CIRCUITS, 'manifest.json'), 'utf8'));
const srsPin = JSON.parse(readFileSync(join(CIRCUITS, 'srs', 'MANIFEST.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

for (const name of ['dark_register', 'dark_transfer', 'dark_withdraw']) {
  const file = join(CIRCUITS, 'target', `${name}.json`);
  if (!existsSync(file)) {
    console.error(`[prepare-assets] missing ${name}.json — run: node circuits/tools/build.mjs`);
    process.exit(1);
  }
  const acir = JSON.parse(readFileSync(file, 'utf8'));
  const got = sha(acir.bytecode);
  const want = manifest.circuits[name].acir_sha256;
  if (got !== want) {
    console.error(`[prepare-assets] ${name} ACIR is ${got}, manifest says ${want} — rebuild the circuits.`);
    process.exit(1);
  }
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify({ bytecode: acir.bytecode }));
  console.log(`[prepare-assets] ${name} ✓ ${got.slice(0, 12)}…`);
}

for (const [file, hash] of [['g1.dat', srsPin.g1Sha256], ['g2.dat', srsPin.g2Sha256]]) {
  const src = join(CIRCUITS, 'srs', file);
  if (!existsSync(src)) {
    console.error(`[prepare-assets] missing ${file} — run: node circuits/tools/extract-srs.mjs`);
    process.exit(1);
  }
  const got = sha(readFileSync(src));
  if (got !== hash) {
    console.error(`[prepare-assets] ${file} is ${got}, pin says ${hash} — refusing to bundle it.`);
    process.exit(1);
  }
  copyFileSync(src, join(OUT, file));
  console.log(`[prepare-assets] ${file} ✓ ${got.slice(0, 12)}…`);
}

// carry the hashes into the artifact, not just the build.
// Verifying them here only protects the build pipeline. This page is meant to be saved, copied and
// republished from the public mirror by anyone — which is exactly the case where the bytes can be
// swapped between the build and the person using it, and where nobody is left to notice.
writeFileSync(
  join(OUT, 'srs.json'),
  JSON.stringify({
    numPoints: srsPin.numPoints,
    form: srsPin.form,
    g1Sha256: srsPin.g1Sha256,
    g2Sha256: srsPin.g2Sha256,
  }),
);
console.log('[prepare-assets] done');
