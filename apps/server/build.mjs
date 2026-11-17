// Bundles the server (and @marquee/shared) into one file. Native modules stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  // @marquee/shared is source TypeScript inside the workspace, so bundle it in.
  plugins: [{
    name: 'bundle-shared',
    setup(b) {
      b.onResolve({ filter: /^@marquee\/shared$/ }, () => ({ path: new URL('../../packages/shared/src/index.ts', import.meta.url).pathname }));
    },
  }],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
console.log('server built → dist/index.js');
