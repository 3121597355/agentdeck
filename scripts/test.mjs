import { build } from 'esbuild';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
await import('./build.mjs');
const files=readdirSync('test').filter(f=>f.endsWith('.test.ts')).map(f=>'test/'+f);
await build({entryPoints:files,bundle:true,platform:'node',format:'esm',target:'node22',external:['esbuild'],outdir:'.test-build',outExtension:{'.js':'.mjs'},logLevel:'warning'});
const child=spawn(process.execPath,['--test','--test-concurrency=4',...files.map(f=>f.replace('test/','.test-build/').replace(/\.ts$/,'.mjs'))],{stdio:'inherit',windowsHide:true,env:{...process.env,AGENT_INBOX_SQLITE:resolve('resources/sqlite3.exe')}});
child.on('exit',code=>process.exitCode=code ?? 1);
