// The part on the PC as one file of the package: pc/part.ts with @quadrohub/pc-sdk bundled in, CommonJS
// (an installed part's folder has no package.json: .cjs is read as CommonJS).
//   node scripts/build-pc.mjs [outfile]   → dist/pc/part.cjs
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildPart(outfile = join(root, 'dist', 'pc', 'part.cjs')) {
  await build({
    entryPoints: [join(root, 'pc', 'part.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'none',
    logLevel: 'warning',
  });
  return outfile;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) console.log(`part → ${await buildPart(process.argv[2])}`);
