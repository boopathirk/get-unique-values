import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

// Entries that do not exist yet are skipped so the build works at every task.
const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['src/csv/worker/csvWorker.ts'], outfile: 'out/csvWorker.js', platform: 'node', format: 'cjs', target: 'node20' },
  { ...common, entryPoints: ['src/viewer/main.ts'], outfile: 'out/viewer.js', platform: 'browser', format: 'iife', target: 'es2022' },
].filter((t) => existsSync(t.entryPoints[0]));

if (watch) {
  for (const t of targets) {
    const ctx = await esbuild.context(t);
    await ctx.watch();
  }
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
