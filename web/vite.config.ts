import { defineConfig } from 'vite';

// A self-contained build: the output directory can be copied anywhere, opened from a file server,
// or served from GitHub Pages, and it will work. No Dark host appears anywhere in it.
export default defineConfig({
  base: './',
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    // The SRS and circuit artifacts are megabytes; warning about them every build is noise.
    chunkSizeWarningLimit: 20_000,
    assetsInlineLimit: 0,
  },
  // bb.js needs these headers for its threaded build; without them it falls back to one thread,
  // which still works, just slower.
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
