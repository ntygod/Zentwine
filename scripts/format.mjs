import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const files=['package.json','pnpm-workspace.yaml','tsconfig.base.json','playwright.config.ts'];
const excluded=new Set(['node_modules','dist','.git','reports','test-results']);
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(excluded.has(entry.name))continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(ts|tsx|mjs|json|css|html)$/.test(entry.name))files.push(file);}}
for(const dir of ['apps','services/api','packages','tests'])walk(dir);
for(const name of fs.readdirSync('scripts'))if(name.endsWith('.mjs'))files.push(path.join('scripts',name));
const result=spawnSync(process.execPath,['node_modules/prettier/bin/prettier.cjs',process.argv.includes('--check')?'--check':'--write',...files],{stdio:'inherit'});
if(result.error)console.error('Formatter could not start');
process.exitCode=result.status??1;
