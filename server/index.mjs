import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { defaults, validateRequest, ApiError } from './validation.mjs';
import { inspectWav } from './wav.mjs';
import { createProviderSettings } from './provider-settings.mjs';
import { createSongwriter } from './songwriter.mjs';
import { createResourceMonitor, assessResources } from './resources.mjs';
import { createTrash } from './trash.mjs';
import { createRadioStation } from './radio.mjs';

const metadataSessionOptions = ['model_weight_context_mb', 'vae_weight_context_mb', 'ar_prefill_graph_arena_mb', 'ar_decode_graph_arena_mb', 'nar_graph_arena_mb', 'vae_graph_arena_mb'].map(name => `yue2.${name}=256`);

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };
const jsonRead = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } };
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}
const within = (base, relative) => {
  const target = path.resolve(base, relative), rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path must remain inside the application directory.');
  return target;
};
function failureDetails(job) {
  if (job.status !== 'failed') return {error:job.error, errorCode:job.errorCode};
  const log = (job.log || []).join('\n');
  if (/GGML_ASSERT\(ctx->mem_buffer != NULL\)|std::bad_alloc|not enough (?:virtual )?memory/i.test(log)) return {errorCode:'HOST_MEMORY', error:'The engine could not reserve system memory. Your lyrics, settings and seed are saved. Wait for memory can hold the retry until other apps leave more room. The current engine profile uses smaller working buffers.'};
  if (/ErrorOutOfDeviceMemory|failed to allocate.*Vulkan|failed to allocate Yue2 NAR graph/i.test(log)) return {errorCode:'GPU_MEMORY', error:`The GPU could not allocate enough memory for this take. Your lyrics, settings and seed are saved. ${job.request?.weight_storage === 'native' || !job.request?.weight_storage ? 'Efficient Q8 reduces memory use. ' : ''}Wait for memory can hold the retry while other apps use the GPU.`};
  return {error:job.error, errorCode:job.errorCode || 'ENGINE_FAILURE'};
}
const publicJob = (job, includeRequest = false) => job ? {
  id: job.id, status: job.status, stage: job.stage, startedAt: job.startedAt, finishedAt: job.finishedAt,
  title:job.request?.title || 'Untitled composition', seed:job.request?.seed || '', queuedAt:job.queuedAt, runStartedAt:job.runStartedAt,
  elapsedSeconds: job.queuedAt && !job.runStartedAt ? 0 : Math.max(0, ((job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) - Date.parse(job.runStartedAt || job.startedAt)) / 1000),
  waitSeconds:job.queuedAt ? Math.max(0, (Date.parse(job.runStartedAt || job.finishedAt || new Date().toISOString()) - Date.parse(job.queuedAt))/1000) : 0,
  waitingReason:job.waitingReason, resourceCheck:job.resourceCheck, retryOf:job.retryOf,
  radio:job.radio,
  log: (job.log || []).slice(-120), ...failureDetails(job), takeId: job.takeId,
  ...(includeRequest ? {request:job.request} : {}),
} : null;

export async function createStudioServer(options = {}) {
  const appHome = path.resolve(options.appHome || process.env.YUE_STUDIO_HOME || moduleRoot);
  const staticRoot = options.staticRoot || path.join(moduleRoot, 'dist');
  const dataRoot = path.join(appHome, 'data');
  const jobRoot = path.join(dataRoot, 'jobs'), takeRoot = path.join(dataRoot, 'takes');
  await fs.mkdir(jobRoot, {recursive: true}); await fs.mkdir(takeRoot, {recursive: true});
  const trash = await createTrash({dataRoot});
  let radio;
  const spawnImpl = options.spawnImpl || spawn;
  const providerSettings = await createProviderSettings({dataRoot, secretStorage: options.secretStorage, environment: options.environment, managedOllama:options.managedOllama});
  const songwriter = createSongwriter({fetchImpl: options.fetchImpl, getKey: providerSettings.getKey, getOllamaBaseUrl: providerSettings.getOllamaBaseUrl});
  let writing = null, writingSettled = null;
  const jobs = new Map(), takes = new Map();
  const readableJob = (job, full=false) => {const value=publicJob(job,full);if(value?.takeId&&!takes.has(value.takeId)){value.takeUnavailable=true;delete value.takeId;}return value;};
  let active = null, child = null, stopping = false, starting = false, waitTimer = null, mutationQueue = Promise.resolve();
  const serialized = operation => { const result = mutationQueue.then(operation); mutationQueue = result.catch(() => {}); return result; };
  for (const entry of await fs.readdir(jobRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const record = await jsonRead(path.join(jobRoot, entry.name, 'job.json'), null);
    if (record?.id === entry.name) {
      if (record.status === 'running' || record.status === 'waiting') {
        const wasWaiting = record.status === 'waiting';
        record.status = wasWaiting ? 'cancelled' : 'failed'; record.stage = wasWaiting ? 'Waiting stopped when studio closed' : 'Interrupted'; record.error = wasWaiting ? undefined : 'The application closed before this take finished. Your composition is still saved.'; record.finishedAt = new Date().toISOString();
        await atomicJson(path.join(jobRoot, record.id, 'job.json'), record);
      }
      jobs.set(record.id, record);
    }
  }
  for (const entry of await fs.readdir(takeRoot, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const record = await jsonRead(path.join(takeRoot, entry.name, 'take.json'), null);
    if (record?.id === entry.name && await exists(path.join(takeRoot, entry.name, 'audio.wav'))) takes.set(record.id, record);
  }
  const hardware = await jsonRead(path.join(appHome, 'runtime', 'hardware.json'), {gpu:'See live computer headroom', cpu:os.cpus()[0]?.model?.trim() || 'CPU', ramGB:Math.round(os.totalmem() / 1024 ** 3)});
  const installedRuntime = await jsonRead(path.join(appHome, 'runtime', 'runtime.json'), null);
  const resourceMonitor = options.resourceMonitor || createResourceMonitor({
    adapterName: typeof installedRuntime?.device === 'string' ? installedRuntime.device : undefined,
  });
  const assess = options.assessResources || assessResources;
  async function memoryCheck(request, fresh = false) { const resources = await resourceMonitor.read({fresh}); return {resources, assessment:assess(resources, request)}; }
  async function runtimeStatus() {
    if (options.runtimeOverride) return options.runtimeOverride;
    const manifest = await jsonRead(path.join(appHome, 'runtime', 'runtime.json'), null);
    const runtime = {name: manifest?.name || 'audio.cpp · YuE2', version: manifest?.version || 'Installing', backend: manifest?.backend || 'vulkan', model: 'YuE2 3B · Q8', verified: Boolean(manifest?.verified)};
    if (!manifest?.executable) return {ready: false, runtime: {...runtime, reason: 'The local runtime is being installed and checked.'}};
    let executable, modelDirectory;
    try { executable = within(path.join(appHome, 'runtime'), manifest.executable); modelDirectory = within(appHome, manifest.modelDirectory || 'models'); } catch (error) { return {ready: false, runtime: {...runtime, reason: error.message}}; }
    if (!(await exists(executable))) return {ready: false, runtime: {...runtime, reason: 'The local runtime executable is missing.'}};
    const required = ['yue2-3b-q8_0.gguf', 'yue2-vae-f16.gguf', 'sidecars/yue2-model-config.json', 'sidecars/yue2-generation-config.json', 'sidecars/yue2-qwen.tiktoken', 'sidecars/yue2-vae-config.json'];
    for (const file of required) if (!(await exists(path.join(modelDirectory, file)))) return {ready: false, runtime: {...runtime, reason: `Model download is incomplete: ${path.basename(file)}`}};
    const modelManifest = await jsonRead(path.join(modelDirectory, 'manifest.json'), null);
    for (const file of modelManifest?.files || []) {
      if (!required.includes(file.path) || !Number.isSafeInteger(file.bytes)) continue;
      if ((await fs.stat(path.join(modelDirectory, file.path))).size !== file.bytes) return {ready: false, runtime: {...runtime, reason: `Model download is incomplete: ${path.basename(file.path)}`}};
    }
    if (!manifest.verified) return {ready: false, runtime: {...runtime, reason: manifest.reason || 'Checking local GPU generation before enabling the console.'}};
    return {ready: true, runtime, executable, modelDirectory, deviceIndex: manifest.deviceIndex};
  }
  async function persistJob(job) { await atomicJson(path.join(jobRoot, job.id, 'job.json'), job); }
  function addLog(job, line) {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 2000);
    if (!clean) return;
    job.log.push(clean); if (job.log.length > 240) job.log.shift();
    if (/loading|load model|gguf|tensor/i.test(clean) && !/semantic|nar|vae_decode/.test(clean)) job.stage = 'Loading the model';
    if (/plan_ms|semantic|autoregressive|AR generation/i.test(clean)) job.stage = 'Composing';
    if (/nar_ms|diffusion|flow matching/i.test(clean)) job.stage = 'Rendering sound';
    if (/vae_decode|decoding audio/i.test(clean)) job.stage = 'Decoding audio';
  }
  async function launch(input, metadata = {}) {
    if (stopping) throw new ApiError(503, 'The studio is closing. Reopen it to generate another take.');
    if (radio?.isRunning() && !metadata.radio) throw new ApiError(409, 'Stop the radio before composing a separate take.');
    if (active || starting) throw new ApiError(409, 'A take is already running. Finish or cancel it first.');
    if (writing) throw new ApiError(409, 'Finish or cancel the song draft before rendering audio.');
    const request = validateRequest(input);
    starting = true;
    try {
      const status = await runtimeStatus();
      if (!status.ready) throw new ApiError(503, status.runtime.reason || 'The runtime is not ready.');
      if (!request.seed) request.seed = String(randomBytes(4).readUInt32LE());
      if (!request.title) request.title = 'Untitled composition';
      const admission = await memoryCheck(request, true);
      if (admission.assessment.state === 'waiting' && !request.wait_for_memory) throw new ApiError(409, `${admission.assessment.reasons.join(' ')} Enable Wait for memory to hold this take until there is more room.`);
      const id = randomUUID(), now = new Date().toISOString();
      const waiting = admission.assessment.state === 'waiting' || (admission.assessment.state === 'unknown' && request.wait_for_memory);
      const job = {id, request, runtime: {...status.runtime, memoryProfile:'bounded-256mib-v1'}, deviceIndex: status.deviceIndex, modelManifest: await jsonRead(path.join(status.modelDirectory, 'manifest.json'), null), status: waiting ? 'waiting' : 'running', stage: waiting ? 'Waiting for memory' : 'Starting the engine', startedAt: now, queuedAt:waiting ? now : undefined, resourceCheck:admission.assessment, resourcesAtSubmission:admission.resources, sessionOptions:[...metadataSessionOptions, ...(request.weight_storage === 'q8_0' ? ['yue2.model_weight_type=q8_0'] : [])], log: [], takeId: null, ...(metadata.retryOf ? {retryOf:metadata.retryOf} : {}), ...(metadata.radio ? {radio:metadata.radio} : {})};
      if (waiting) {
        job.waitingReason = admission.assessment.state === 'unknown' ? 'Waiting for memory readings. If they stay unavailable, turn off Wait for memory to attempt generation without this check.' : admission.assessment.reasons.join(' ');
        await atomicJson(path.join(jobRoot,id,'request.json'),request);
        await persistJob(job); jobs.set(id,job); active=job;
        scheduleWaiting(job);
        return publicJob(job);
      }
      return await startEngine(job, status);
    } finally { starting = false; }
  }
  function scheduleWaiting(job) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(async () => {
      if (stopping || active?.id !== job.id || job.status !== 'waiting') return;
      if (starting) { scheduleWaiting(job); return; }
      starting = true;
      try {
        const admission = await memoryCheck(job.request, true);
        if (stopping || job.cancelRequested || active?.id !== job.id) return;
        job.resourceCheck = admission.assessment;
        if (admission.assessment.state === 'ready') {
          const status = await runtimeStatus();
          if (!status.ready) throw new ApiError(503,status.runtime.reason || 'The engine is unavailable.');
          if (stopping || job.cancelRequested || active?.id !== job.id) return;
          job.resourcesAtStart = admission.resources;
          await startEngine(job,status);
        } else {
          job.waitingReason = admission.assessment.state === 'unknown' ? 'Waiting for fresh memory readings before starting this queued take.' : admission.assessment.reasons.join(' ');
          await persistJob(job);
        }
      } catch (error) {
        if (active?.id === job.id && !job.cancelRequested) {
          job.status='failed';job.stage='Could not start queued take';job.error=error.message;job.finishedAt=new Date().toISOString();
          await persistJob(job).catch(()=>{});active=null;
        }
      } finally { starting=false; if (!stopping && active?.id === job.id && job.status === 'waiting') scheduleWaiting(job); }
    }, options.memoryPollMs ?? 5000);
    waitTimer.unref?.();
  }
  async function startEngine(job,status) {
      const {id, request} = job, directory = path.join(jobRoot,id), output = path.join(directory,'audio.wav');
      job.status='running';job.stage='Starting the engine';job.runStartedAt=new Date().toISOString();delete job.waitingReason;
      await fs.mkdir(directory, {recursive: true});
      await atomicJson(path.join(directory, 'request.json'), request);
      const sequenceFile = path.join(directory, 'sequence.json');
      const args = ['--task', 'gen', '--family', 'yue2', '--model', status.modelDirectory, '--backend', request.backend, '--threads', String(request.threads), '--request-sequence', sequenceFile, '--batch-merge-audio', 'concat', '--out', output, '--log', '--metrics'];
      if (request.backend === 'vulkan' && Number.isInteger(status.deviceIndex)) args.push('--device', String(status.deviceIndex));
      if (request.weight_storage === 'q8_0') args.push('--session-option', 'yue2.model_weight_type=q8_0');
      for (const option of metadataSessionOptions) args.push('--session-option', option);
      const modelOptions = {};
      for (const key of ['seed', 'style', 'cot', 'num_inference_steps', 'cfg_scale', ...['abc', 'semantic'].flatMap(prefix => ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'penalty_window', 'min_tokens', 'max_tokens'].map(suffix => `${prefix}_${suffix}`))]) modelOptions[key] = String(request[key]);
      if (request.abc) {
        const score = path.join(directory, 'score.abc'); await fs.writeFile(score, request.abc, 'utf8');
        modelOptions.abc_file = score;
      }
      await atomicJson(sequenceFile, [{id: 'take', text: request.lyrics, options: modelOptions}]);
      await persistJob(job); jobs.set(id, job); active = job;
      const logFile = path.join(directory, 'engine.log');
      let rawLog = '', pendingLogWrite = Promise.resolve(), finalized = false;
      const finish = async (code, signal, spawnError) => {
        if (finalized) return; finalized = true;
        try {
          await pendingLogWrite;
          if (rawLog) addLog(job, rawLog);
          if (job.cancelRequested) { job.status = 'cancelled'; job.stage = 'Cancelled'; }
          else if (spawnError || code !== 0) {
            job.status = 'failed'; job.stage = 'Engine stopped';
            job.error = spawnError ? `Could not start the engine: ${spawnError.message}` : `The engine exited ${signal || `with code ${code}`}. ${job.log.slice(-5).join(' ').slice(-900)}`;
            Object.assign(job,failureDetails(job));
          } else {
            job.stage = 'Saving the take';
            const audio = await inspectWav(output), destination = path.join(takeRoot, id);
            await fs.mkdir(destination, {recursive: true});
            await fs.rename(output, path.join(destination, 'audio.wav'));
            await fs.copyFile(path.join(directory, 'request.json'), path.join(destination, 'request.json'));
            if (request.abc) await fs.copyFile(path.join(directory, 'score.abc'), path.join(destination, 'score.abc'));
            const take = {id, title: request.title, createdAt: new Date().toISOString(), duration: audio.duration, sampleRate: audio.sampleRate, channels: audio.channels, peaks: audio.peaks, favorite: false, hasScore: Boolean(request.abc), request, audioUrl: `/api/takes/${id}/audio`, diagnostics: {peak: audio.peak, rms: audio.rms, bytes: audio.bytes, runtime: status.runtime.version, backend: request.backend}};
            if(job.radio)take.radio=job.radio;
            await atomicJson(path.join(destination, 'take.json'), take); takes.set(id, take);
            job.takeId = id; job.status = 'completed'; job.stage = 'Ready to listen';
          }
        } catch (error) { job.status = 'failed'; job.stage = 'Could not save audio'; job.error = error.message; }
        finally {
          job.finishedAt = new Date().toISOString();
          await persistJob(job).catch(error => console.error('Could not persist job:', error.message));
          if (active?.id === id) { active = null; child = null; }
        }
      };
      if (stopping || job.cancelRequested) { job.cancelRequested=true; await finish(null,null,null); return publicJob(job); }
      try {
        child = spawnImpl(status.executable, args, {cwd: path.dirname(status.executable), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
        if (Number.isInteger(child.pid)) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Priority is best-effort and never changes other processes. */ } }
        const onChunk = chunk => {
          const text = chunk.toString();
          pendingLogWrite = pendingLogWrite.then(() => fs.appendFile(logFile, text)).catch(() => {});
          rawLog += text;
          const lines = rawLog.split(/[\r\n]+/); rawLog = lines.pop() || '';
          for (const line of lines) addLog(job, line);
        };
        child.stdout?.on('data', onChunk); child.stderr?.on('data', onChunk);
        let processError;
        child.on('error', error => {
          processError = error;
          onChunk(Buffer.from(`[studio] Engine process error: ${error.message}\n`));
          if (job.cancelRequested) {
            job.stage = 'Could not stop the engine';
            job.error = 'Stopping the engine failed. This take remains locked until its process closes. You can try Cancel again.';
            void persistJob(job).catch(() => {});
          }
          // An error may mean kill failed while the child is still alive. Only
          // close releases the generation lock. Node also emits close after an
          // asynchronous failed-spawn error, so missing executables still finish.
        });
        child.once('close', (code, signal) => { void finish(code, signal, processError); });
      } catch (error) { void finish(null, null, error); }
      return publicJob(job);
  }
  async function cancel(id) {
    const job = jobs.get(id); if (!job) throw new ApiError(404, 'Take job not found.');
    if (job.status === 'waiting') {
      clearTimeout(waitTimer); job.cancelRequested=true;job.status='cancelled';job.stage='Waiting cancelled';job.finishedAt=new Date().toISOString();
      await persistJob(job);if(active?.id===id)active=null;return publicJob(job);
    }
    if (job.status !== 'running') return publicJob(job);
    job.cancelRequested = true; job.stage = 'Stopping the engine'; await persistJob(job);
    if (child && active?.id === id) {
      // CLI is a single native process. Killing it releases the GPU allocation.
      try {
        if (!child.kill('SIGKILL')) throw new Error('The stop signal was not delivered. This take remains locked until the process closes.');
      } catch (error) { throw new ApiError(500, `Could not stop the engine: ${error.message}`); }
    }
    return publicJob(job);
  }
  async function withWriter(method,input,{signal}={}) {
    if(stopping)throw new ApiError(503,'The studio is closing.');
    if(active||starting||writing)throw new ApiError(409,'The local engine or writer is busy.');
    const controller=new AbortController();writing=controller;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    const work=songwriter[method](input,{signal:controller.signal});
    writingSettled=work.then(()=>{},()=>{});
    try{return await work;}finally{signal?.removeEventListener('abort',abort);if(writing===controller){writing=null;writingSettled=null;}}
  }
  radio=await createRadioStation({dataRoot,
    compose:(input,options)=>withWriter('compose',input,options),chat:(input,options)=>withWriter('chat',input,options),
    generate:(request,metadata)=>launch(request,metadata),getJob:id=>readableJob(jobs.get(id)),getTake:id=>takes.get(id),cancelJob:cancel,
    isBusy:()=>Boolean(active||starting||writing),tickMs:options.radioTickMs,
  });
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const permitted = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!permitted.has(req.headers.host)) { res.writeHead(403); res.end('Local requests only.'); return; }
    const origin = req.headers.origin;
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(options.allowDevOrigin ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [])]);
    if (origin && !allowedOrigins.has(origin)) { res.writeHead(403); res.end('This origin is not allowed.'); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const reply = (status, value) => { if (!res.headersSent) res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
    const body = async () => {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'Send JSON with Content-Type application/json.');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 220000) throw new ApiError(413, 'Request is too large.'); chunks.push(chunk); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'Request contains invalid JSON.'); }
    };
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`), route = url.pathname, method = req.method;
      if(route==='/api/radio'&&method==='GET')return reply(200,{radio:await radio.snapshot()});
      if(route.startsWith('/api/radio/')){
        let result;
        if(route==='/api/radio/config'&&method==='PUT')result=await radio.configure(await body());
        else if(route==='/api/radio/start'&&method==='POST'){const input=await body();if(Object.keys(input).some(key=>key!=='config'))throw new ApiError(400,'Unsupported radio start option.');if(active||starting||writing)throw new ApiError(409,'Finish the current take or writer first.');result=await radio.start(input.config);}
        else if(route==='/api/radio/stop'&&method==='POST'){await body();result=await radio.stop();}
        else if(route==='/api/radio/message'&&method==='POST'){const input=await body();result=await radio.message(input);}
        else if(route==='/api/radio/consume'&&method==='POST'){const input=await body();result=await radio.consume(input.takeId);}
        else if(route==='/api/radio/memories'&&method==='PUT'){const input=await body();result=await radio.remember(input);}
        else if(route.startsWith('/api/radio/memories/')&&method==='DELETE')result=await radio.forget(decodeURIComponent(route.slice('/api/radio/memories/'.length)));
        else if(route==='/api/radio/reset'&&method==='POST'){await body();result=await radio.resetMemories();}
        else throw new ApiError(405,'This radio operation is not supported.');
        return reply(200,{radio:result||await radio.snapshot()});
      }
      if(route==='/api/trash'&&method==='GET')return reply(200,{entries:await trash.list()});
      if(route==='/api/trash/purge'&&method==='POST'){const input=await body();if(input.confirm!==true||Object.keys(input).some(key=>!['confirm','ids'].includes(key)))throw new ApiError(400,'Confirm the exact trash items to delete permanently.');return reply(200,await serialized(()=>trash.purge(input.ids)));}
      const restoreMatch=route.match(/^\/api\/trash\/([0-9a-f-]{36})\/restore$/);
      if(restoreMatch&&method==='POST'){
        await body();const entry=await serialized(async()=>{const restored=await trash.restore(restoreMatch[1]);const folder=restored.kind==='take'?takeRoot:jobRoot;const record=await jsonRead(path.join(folder,restored.originalId,restored.kind==='take'?'take.json':'job.json'),null);if(record)(restored.kind==='take'?takes:jobs).set(restored.originalId,record);return restored;});return reply(200,{entry});
      }
      if (route === '/api/resources' && method === 'GET') {
        const maximum = Number(url.searchParams.get('semantic_max_tokens') || defaults.semantic_max_tokens);
        const profile = validateRequest({...defaults, lyrics:'Resource check', style:'Resource check', semantic_max_tokens:maximum, semantic_min_tokens:Math.min(defaults.semantic_min_tokens,maximum), cot:url.searchParams.get('cot') || defaults.cot, backend:url.searchParams.get('backend') || defaults.backend, weight_storage:url.searchParams.get('weight_storage') || defaults.weight_storage});
        return reply(200,await memoryCheck(profile));
      }
      if (route === '/api/jobs' && method === 'GET') return reply(200,{jobs:[...jobs.values()].sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,50).map(job=>readableJob(job,true))});
      if (route === '/api/writer/settings' && method === 'GET') return reply(200, {settings: providerSettings.publicSettings()});
      if (route === '/api/writer/settings' && method === 'PUT') {
        const input = await body();
        return reply(200, {settings: await serialized(() => providerSettings.update(input))});
      }
      if (route === '/api/writer/models' && method === 'GET') {
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', onClose);
        try { return reply(200, await songwriter.listModels(url.searchParams.get('provider'), {signal:controller.signal})); }
        finally { res.removeListener('close', onClose); }
      }
      if (route === '/api/writer/compose' && method === 'POST') {
        const input = await body();
        if (stopping) throw new ApiError(503, 'The studio is closing.');
        if(radio?.isRunning())throw new ApiError(409,'Stop the radio before using the separate songwriter.');
        if (active || starting) throw new ApiError(409, 'Finish or cancel the current audio take before writing a song.');
        if (writing) throw new ApiError(409, 'A song draft is already being written.');
        const controller = new AbortController(); writing = controller;
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', onClose);
        const work = songwriter.compose(input, {signal:controller.signal});
        // The adapter's finally block has a bounded, independent Ollama unload.
        // Keep a rejection-handled settlement promise so desktop shutdown can
        // await cleanup before it tears down Electron and its fetch requests.
        writingSettled = work.then(() => {}, () => {});
        try { return reply(200, await work); }
        finally { if (writing === controller) {writing = null; writingSettled = null;} res.removeListener('close', onClose); }
      }
      if (route === '/api/status' && method === 'GET') { const status = await runtimeStatus(); return reply(200, {ready: status.ready, runtime: status.runtime, hardware, activeJob: readableJob(active), writerBusy: Boolean(writing), radioActive:Boolean(radio?.isRunning()), resources:await resourceMonitor.read()}); }
      if (route === '/api/defaults' && method === 'GET') return reply(200, {defaults});
      if (route === '/api/takes' && method === 'GET') return reply(200, {takes: [...takes.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))});
      if (route === '/api/generate' && method === 'POST') return reply(202, {job: await launch(await body())});
      if (route === '/api/draft' && method === 'GET') return reply(200, {draft: await jsonRead(path.join(dataRoot, 'draft.json'), installedRuntime?.backend === 'cpu' ? {...defaults,backend:'cpu'} : null)});
      if (route === '/api/draft' && method === 'PUT') {
        const value = await body();
        if (!value || typeof value.draft !== 'object' || Array.isArray(value.draft) || value.draft === null) throw new ApiError(400, 'Expected {draft: {...}}.');
        // Drafts may be unfinished; full model validation happens on Generate.
        await serialized(() => atomicJson(path.join(dataRoot, 'draft.json'), value.draft)); return reply(200, {draft: value.draft});
      }
      const match = route.match(/^\/api\/(jobs|takes)\/([0-9a-f-]{36})(?:\/(audio|score|request|cancel|retry|log))?$/);
      if (match) {
        const [, kind, id, action] = match;
        if(!action&&method==='DELETE'){
          const collection=kind==='takes'?takes:jobs,record=collection.get(id);if(!record)throw new ApiError(404,'This item is no longer available.');
          if(active?.id===id||record.status==='running'||record.status==='waiting')throw new ApiError(409,'Stop this attempt before deleting it.');
          const entry=await serialized(async()=>{const current=collection.get(id);if(!current)throw new ApiError(404,'This item is no longer available.');if(active?.id===id||current.status==='running'||current.status==='waiting')throw new ApiError(409,'Stop this attempt before deleting it.');const value=await trash.put({kind:kind==='takes'?'take':'job',id,title:current.title||current.request?.title});collection.delete(id);return value;});
          if(kind==='takes')await radio.removeTake(id);
          return reply(200,{entry});
        }
        if (kind === 'jobs') {
          const job = jobs.get(id); if (!job) throw new ApiError(404, 'Job not found.');
          if (!action && method === 'GET') return reply(200, {job: readableJob(job)});
          if (action === 'cancel' && method === 'POST') return reply(200, {job: await cancel(id)});
          if (action === 'retry' && method === 'POST') {
            if (job.status === 'waiting' || job.status === 'running') throw new ApiError(409,'This attempt is already active.');
            const preferences=await body();
            if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || Object.keys(preferences).some(key=>key!=='wait_for_memory') || ('wait_for_memory' in preferences && typeof preferences.wait_for_memory !== 'boolean')) throw new ApiError(400,'Retry accepts only the Wait for memory preference.');
            return reply(202,{job:await launch({...job.request,weight_storage:job.request.weight_storage || 'native',wait_for_memory:preferences.wait_for_memory ?? true},{retryOf:id})});
          }
          if (action === 'log' && method === 'GET') {
            const logFile=path.join(jobRoot,id,'engine.log');
            const log=await exists(logFile) ? await fs.readFile(logFile,'utf8') : (job.log || []).join('\n') || job.waitingReason || 'This attempt did not start the engine.';
            res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="YuE-${id}.log"`,'Cache-Control':'no-store'});return res.end(log);
          }
        } else {
          let take = takes.get(id); if (!take) throw new ApiError(404, 'Take not found.');
          if (!action && method === 'PATCH') {
            const update = await body();
            if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some(key => !['title', 'favorite'].includes(key))) throw new ApiError(400, 'Only title and favorite can be changed.');
            if ('title' in update && (typeof update.title !== 'string' || !update.title.trim() || update.title.length > 160)) throw new ApiError(400, 'Use a title between 1 and 160 characters.');
            if ('favorite' in update && typeof update.favorite !== 'boolean') throw new ApiError(400, 'favorite must be true or false.');
            await serialized(async () => {take=takes.get(id);if(!take)throw new ApiError(404,'This take was deleted before the change could be saved.');Object.assign(take, update.title ? {...update, title: update.title.trim()} : update); await atomicJson(path.join(takeRoot, id, 'take.json'), take); });
            return reply(200, {take});
          }
          if (method === 'GET' && ['audio', 'score', 'request'].includes(action)) {
            if (action === 'score' && !take.hasScore) throw new ApiError(404, 'This take has no supplied ABC score.');
            const name = action === 'audio' ? 'audio.wav' : action === 'score' ? 'score.abc' : 'request.json';
            const file = path.join(takeRoot, id, name), size = (await fs.stat(file)).size;
            const type = action === 'audio' ? 'audio/wav' : action === 'score' ? 'text/plain; charset=utf-8' : 'application/json';
            const safeName = take.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 80) || 'YuE take';
            const headers = {'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Disposition': `${url.searchParams.has('download') ? 'attachment' : 'inline'}; filename="${safeName}.${action === 'audio' ? 'wav' : action === 'score' ? 'abc' : 'json'}"`};
            let start = 0, end = size - 1, code = 200;
            if (req.headers.range) {
              const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
              if (!range || (!range[1] && !range[2])) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
              if (!range[1]) start = Math.max(0, size - Number(range[2]));
              else { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
              if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
              code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }
            headers['Content-Length'] = end - start + 1; res.writeHead(code, headers);
            const stream = createReadStream(file, {start, end}); stream.on('error', () => res.destroy()); stream.pipe(res); return;
          }
        }
        throw new ApiError(405, 'This operation is not supported.');
      }
      if (route.startsWith('/api/')) throw new ApiError(404, 'API route not found.');
      if (method !== 'GET' && method !== 'HEAD') throw new ApiError(405, 'Method not allowed.');
      let file;
      try { file = within(staticRoot, decodeURIComponent(route).replace(/^\/+/, '') || 'index.html'); } catch { throw new ApiError(403, 'Path is not allowed.'); }
      if (!await exists(file) || (await fs.stat(file)).isDirectory()) file = path.join(staticRoot, 'index.html');
      if (!await exists(file)) { res.writeHead(503, {'Content-Type': 'text/plain'}); return res.end('The studio interface has not been built. Run pnpm build.'); }
      const extension = path.extname(file), mime = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.png':'image/png', '.ico':'image/x-icon'}[extension] || 'application/octet-stream';
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
      res.writeHead(200, {'Content-Type': mime, 'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600'});
      if (method === 'HEAD') return res.end();
      const stream = createReadStream(file); stream.on('error', () => res.destroy()); stream.pipe(res);
    } catch (error) { if (!res.headersSent) reply(error.status || 500, {error: error.status ? error.message : `Local server error: ${error.message}`}); else res.destroy(); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 18743, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {server, url, appHome, async close() {
    if (stopping) return; stopping = true;
    await radio.close();
    clearTimeout(waitTimer);
    const writerCleanup = writingSettled;
    writing?.abort();
    await writerCleanup;
    while (starting) await new Promise(resolve => setTimeout(resolve, 10));
    if (active) { await cancel(active.id); const start = Date.now(); while (active && Date.now() - start < 5000) await new Promise(resolve => setTimeout(resolve, 50)); }
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await closed; await mutationQueue;
  }};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const studio = await createStudioServer({allowDevOrigin: process.env.NODE_ENV === 'development'});
  console.log(`YuE Studio: ${studio.url}`);
  const stop = async () => { await studio.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
