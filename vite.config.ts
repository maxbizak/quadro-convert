import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The package's screen, built for Hub's sandbox:
// - relative addresses (base './'): Hub serves the files from the package's own folder;
// - the bridge /pkg-sdk/v1/quadro.js and the UI kit /pkg-sdk/v1/quadro-ui.css come from Hub (`vite-ignore` in index.html);
// - out goes dist/ = the package: manifest.json + client/ (what `npm run qhapp -- pack dist …` signs).

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** dist/manifest.json next to dist/client/: the folder is the whole package. */
function manifest(): Plugin {
  return {
    name: 'qhapp-manifest',
    closeBundle() {
      mkdirSync(here('./dist'), { recursive: true });
      copyFileSync(here('./manifest.json'), here('./dist/manifest.json'));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [manifest()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // One file of code and one of styles: easy to read in the review of the Catalog.
    assetsInlineLimit: 0,
    rollupOptions: { output: { entryFileNames: 'app.js', chunkFileNames: 'chunk-[hash].js', assetFileNames: '[name][extname]' } },
  },
});
