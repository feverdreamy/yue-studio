const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {spawn, execFile} = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** The shareable edition owns its writer; it never stops the user's other Ollama. */
async function startLocalWriter(appHome) {
  let installation;
  try {installation = JSON.parse(await fs.readFile(path.join(appHome, 'portable.json'), 'utf8'));}
  catch (error) {if(error.code === 'ENOENT') return null; throw error;}
  if (installation.version !== 1) throw new Error('Unsupported installation settings. Run Install again.');
  const executable = path.join(appHome, 'writer', 'ollama.exe');
  const models = installation.writerModels ? path.resolve(installation.writerModels) : path.join(appHome, 'writer', 'models');
  await fs.access(executable).catch(() => {throw new Error('The local writer is missing. Run 1 - Install YuE Studio.cmd first.');});
  const dataRoot = path.join(appHome, 'data');
  await fs.mkdir(dataRoot, {recursive:true});
  const marker = path.join(dataRoot, 'managed-writer.json');
  let previousUrl;
  try {previousUrl = JSON.parse(await fs.readFile(marker, 'utf8')).url;} catch {}
  // Reuse a compatible local service only when it can see the installed writer.
  try {
    const endpoint = new URL(installation.existingOllamaUrl || 'http://127.0.0.1:11434');
    if(!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw new Error('Not a local Ollama endpoint.');
    const url=endpoint.origin;
    const versionResponse=await fetch(`${url}/api/version`,{signal:AbortSignal.timeout(1000),redirect:'error'});
    const version=(await versionResponse.json()).version;
    const parts=String(version).split('.').map(Number);
    const compatible=versionResponse.ok && (parts[0]>0 || parts[1]>33 || parts[1]===33 && parts[2]>=3);
    if(compatible){
      const response=await fetch(`${url}/api/tags`,{signal:AbortSignal.timeout(1000),redirect:'error'});
      const tags=(await response.json()).models;
      if(response.ok && Array.isArray(tags) && tags.some(model=>(model.name||model.model)==='granite4.2:3b')){
        await fs.writeFile(marker,JSON.stringify({url},null,2));
        return {url,previousUrl,owned:false,close:async()=>{}};
      }
    }
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `http://127.0.0.1:${await freePort()}`;
    const log = syncFs.openSync(path.join(dataRoot, 'writer-runtime.log'), 'a');
    const child = spawn(executable, ['serve'], {
      cwd:path.dirname(executable), windowsHide:true, stdio:['ignore',log,log],
      env:{...process.env, OLLAMA_HOST:url, OLLAMA_MODELS:models, OLLAMA_NUM_PARALLEL:'1', OLLAMA_MAX_LOADED_MODELS:'1', OLLAMA_CONTEXT_LENGTH:'8192', OLLAMA_KEEP_ALIVE:'0', OLLAMA_NO_CLOUD:'1'},
    });
    syncFs.closeSync(log);
    let exited = false, launchError;
    child.once('error', error => {launchError = error; exited = true;});
    child.once('exit', () => {exited = true;});
    let closePromise;
    const close = () => closePromise ||= new Promise(resolve => {
      if (exited || !child.pid) return resolve();
      if (process.platform === 'win32') execFile('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true}, () => resolve());
      else {child.once('exit', resolve); child.kill('SIGTERM');}
    });
    let ready = false;
    for (let wait = 0; wait < 120 && !exited; wait++) {
      try {
        const response = await fetch(`${url}/api/version`, {signal:AbortSignal.timeout(750),redirect:'error'});
        if (response.ok && typeof (await response.json()).version === 'string') {ready = true; break;}
      } catch {}
      await new Promise(resolve => setTimeout(resolve,250));
    }
    if (ready) {
      await fs.writeFile(marker, JSON.stringify({url}, null, 2));
      return {url, previousUrl, pid:child.pid, owned:true, close};
    }
    await close();
    if (launchError) throw new Error(`The local writer could not start: ${launchError.message}`);
  }
  throw new Error('The local writer did not become ready. Run Install again or inspect data/writer-runtime.log.');
}
module.exports = {startLocalWriter};
