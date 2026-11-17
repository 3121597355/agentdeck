import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('build', { recursive: true });
await Promise.all([
  build({entryPoints:['desktop/main.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],outfile:'build/main.cjs'}),
  build({entryPoints:['desktop/preload.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'build/preload.cjs'}),
  build({entryPoints:['cli/agent-inbox.ts'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'build/agent-inbox.mjs'})
]);
