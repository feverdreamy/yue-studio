import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = path.resolve(root, '../../work');
await fs.mkdir(workRoot, {recursive:true});
const stage = await fs.mkdtemp(path.join(workRoot, 'package-stage-'));
const out = await fs.mkdtemp(path.join(workRoot, 'package-build-'));
for (const directory of ['dist','server','electron','assets']) await fs.cp(path.join(root,directory),path.join(stage,directory),{recursive:true,force:true});
const sourcePackage = JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
await fs.writeFile(path.join(stage,'package.json'),JSON.stringify({name:'yue-studio',productName:'YuE Studio',version:sourcePackage.version,description:'A local composition console for YuE2',author:'YuE Studio',main:'electron/main.cjs',type:'module'}));
const packaged = await packager({dir:stage,out,platform:'win32',arch:'x64',name:'YuE Studio',executableName:'YuE Studio',electronVersion:'40.10.6',asar:true,overwrite:true,prune:false,icon:path.join(root,'assets','icon.ico'),win32metadata:{CompanyName:'YuE Studio',FileDescription:'YuE Studio — local composition console',ProductName:'YuE Studio'},appCopyright:'YuE Studio interface. Model and runtime retain their respective licenses.'});
await fs.cp(packaged[0],path.join(root,'desktop'),{recursive:true,force:true});
console.log(`Portable desktop ready: ${path.join(root,'desktop','YuE Studio.exe')}`);
