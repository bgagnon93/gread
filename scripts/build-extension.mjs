// Bundles the MV3 extension into dist/. Content scripts and service workers
// can't use ES module imports at runtime, so each entry is bundled to a single
// self-contained IIFE. Run with --watch to rebuild on change.
import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Static assets copied as-is.
await cp('src/manifest.json', `${outdir}/manifest.json`);

const options = {
  entryPoints: {
    'service-worker': 'src/background/service-worker.ts',
    content: 'src/content/content.ts',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  outdir,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching for changes…');
} else {
  await build(options);
}
