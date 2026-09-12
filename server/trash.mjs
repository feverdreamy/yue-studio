import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError} from './validation.mjs';

const validId = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const exists = async file => { try {await fs.lstat(file);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;} };
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

export async function createTrash({dataRoot}) {
  const root=path.resolve(dataRoot),trashRoot=path.join(root,'trash');
  await fs.mkdir(trashRoot,{recursive:true});
  async function checked(directory) {
    const relative=path.relative(root,path.resolve(directory));
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new ApiError(400,'This location is outside the studio data folder.');
    const stat=await fs.lstat(directory),real=await fs.realpath(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink()||normalized(real)!==normalized(directory))throw new ApiError(409,'Linked folders cannot be changed from the studio.');
    return directory;
  }
  async function treeBytes(directory) {
    await checked(directory);let bytes=0;
    for(const item of await fs.readdir(directory,{withFileTypes:true})){
      if(item.isSymbolicLink())throw new ApiError(409,'Linked files cannot be changed from the studio.');
      const file=path.join(directory,item.name);
      bytes+=item.isDirectory()?await treeBytes(file):(await fs.stat(file)).size;
    }
    return bytes;
  }
  async function read(id) {
    if(!validId(id))throw new ApiError(400,'Invalid trash item.');
    const directory=path.join(trashRoot,id);
    if(!await exists(directory))throw new ApiError(404,'This trash item is no longer available.');
    await checked(directory);
    let entry;try{entry=JSON.parse(await fs.readFile(path.join(directory,'entry.json'),'utf8'));}catch{throw new ApiError(409,'This trash record could not be read. Its files were preserved.');}
    if(entry.id!==id||!validId(entry.originalId)||!['take','job'].includes(entry.kind))throw new ApiError(409,'This trash record is invalid. Its files were preserved.');
    return {entry,directory,payload:path.join(directory,'payload'),original:path.join(root,entry.kind==='take'?'takes':'jobs',entry.originalId)};
  }
  async function list() {
    const entries=[];
    for(const item of await fs.readdir(trashRoot,{withFileTypes:true})){
      if(!item.isDirectory()||item.isSymbolicLink()||!validId(item.name))continue;
      try{const record=await read(item.name);if(await exists(record.payload))entries.push(record.entry);}catch{/* Preserve an unreadable record for manual recovery. */}
    }
    return entries.sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));
  }
  async function put({kind,id,title}) {
    if(!['take','job'].includes(kind)||!validId(id))throw new ApiError(400,'Invalid item to delete.');
    const original=path.join(root,kind==='take'?'takes':'jobs',id);
    const bytes=await treeBytes(original),trashId=randomUUID(),directory=path.join(trashRoot,trashId);
    await checked(trashRoot);await fs.mkdir(directory);
    const entry={id:trashId,kind,originalId:id,title:String(title||'Untitled').slice(0,160),deletedAt:new Date().toISOString(),bytes};
    // The journal precedes an atomic same-volume rename. A crash can leave an
    // empty journal, but never hides or duplicates the original audio.
    await fs.writeFile(path.join(directory,'entry.json'),JSON.stringify(entry,null,2));
    await checked(original);await checked(directory);
    await fs.rename(original,path.join(directory,'payload'));
    return entry;
  }
  async function restore(id) {
    const {entry,directory,payload,original}=await read(id);
    if(await exists(original))throw new ApiError(409,'The original location already exists; both copies were preserved.');
    await checked(payload);await checked(path.dirname(original));
    await fs.rename(payload,original);
    await fs.unlink(path.join(directory,'entry.json')).catch(()=>{});await fs.rmdir(directory).catch(()=>{});
    return entry;
  }
  async function purge(ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>500||ids.some(id=>!validId(id))||new Set(ids).size!==ids.length)throw new ApiError(400,'Select 1–500 distinct trash items to delete permanently.');
    const records=[];
    // Validate the exact requested snapshot before deleting any entry.
    for(const id of ids){const record=await read(id);await treeBytes(record.directory);records.push(record);}
    let freedBytes=0;const deleted=[];
    for(const record of records){
      await checked(record.directory);
      await fs.rm(record.directory,{recursive:true,force:false});
      freedBytes+=record.entry.bytes;deleted.push(record.entry.id);
    }
    return {deleted,freedBytes};
  }
  return {list,put,restore,purge};
}
