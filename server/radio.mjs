import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {ApiError,defaults,validateRequest} from './validation.mjs';
import {validateSong,validateSongwriterInput,validateRadioHostResult} from './songwriter.mjs';

const clone=value=>structuredClone(value);
const timestamp=()=>new Date().toISOString();
const validKey=key=>typeof key==='string'&&/^[a-z][a-z0-9_-]{0,47}$/.test(key)&&!['constructor','prototype','__proto__'].includes(key);
const text=(value,max,label,empty=false)=>{
  if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)||(!empty&&!value.trim()))throw new ApiError(400,`${label} must contain ${empty?'0':'1'}–${max} characters.`);
  return value.trim();
};
const initialConfig=()=>({provider:'ollama',model:'',idea:'Original songs for a late-night station.',style:defaults.style,seed:'',durationSeconds:45,bufferAhead:1,maxTracksPerSession:0,generation:{...defaults,cfg_scale:1}});
function configuration(patch,previous=initialConfig()) {
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!Object.hasOwn(previous,key)))throw new ApiError(400,'Unknown radio configuration setting.');
  const config={...previous,...patch,generation:Object.hasOwn(patch,'generation')?validateRequest(patch.generation):clone(previous.generation)};
  if(!['ollama','deepinfra','openai'].includes(config.provider))throw new ApiError(400,'Choose a supported radio writer provider.');
  config.model=text(config.model,250,'Radio model',true);
  if(/[\s\x00-\x1f\x7f]/.test(config.model))throw new ApiError(400,'Choose a valid radio model identifier.');
  config.idea=text(config.idea,1500,'Station idea');config.style=text(config.style,2000,'Station style');
  if(Object.hasOwn(patch,'generation')&&!Object.hasOwn(patch,'seed')&&!previous.seed)config.seed=config.generation.seed;
  validateRequest({...config.generation,seed:config.seed});
  if(!Number.isInteger(config.durationSeconds)||config.durationSeconds<10||config.durationSeconds>360)throw new ApiError(400,'Radio duration must be 10–360 seconds.');
  if(![1,2].includes(config.bufferAhead))throw new ApiError(400,'Prepare one or two tracks ahead.');
  if(!Number.isInteger(config.maxTracksPerSession)||config.maxTracksPerSession<0||config.maxTracksPerSession>10000)throw new ApiError(400,'Session limit must be 0 for unlimited, or 1–10000 tracks.');
  return config;
}
function checkedMemories(memories) {
  if(memories.length>32||memories.some(item=>!validKey(item.key)||typeof item.value!=='string'||!item.value.trim()||item.value.length>500||/[\x00-\x1f]/.test(item.value)))throw new ApiError(400,'Use at most 32 short musical preferences, with simple lowercase keys and values up to 500 characters.');
  if(JSON.stringify(memories.map(({key,value})=>({key,value}))).length>2000)throw new ApiError(400,'Keep the combined remembered musical preferences below 2000 characters.');
  return memories;
}
function effectiveStyle(config,memories){const result=config.style+(memories.length?'; Listener preferences: '+memories.map(item=>`${item.key}: ${item.value}`).join('; '):'');if(result.length>2000)throw new ApiError(400,'The pinned style and remembered preferences together exceed 2000 characters. Shorten one before continuing.');return result;}
function arrangedStyle(song,memories){const suffix=memories.length?'; Preference overrides: '+memories.map(item=>`${item.key}: ${item.value}`).join('; '):'';if(song.style.length+suffix.length>2000)throw new ApiError(502,'The writer returned too much style detail to fit the active preferences. No automatic retry was made.');return song.style+suffix;}

/** One writer/render pipeline, durable preferences, and an explicitly started station. */
export async function createRadioStation({dataRoot,compose,chat,generate,getJob,getTake,cancelJob,isBusy=()=>false,tickMs=1000}={}) {
  for(const [name,callback] of Object.entries({compose,chat,generate,getJob,getTake,cancelJob}))if(typeof callback!=='function')throw new Error(`Radio requires ${name}.`);
  const file=path.join(dataRoot,'radio.json');let saved;
  try{saved=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Radio preferences could not be read. The saved file has not been changed.');}
  let config=configuration(saved?.config??{}),memories=checkedMemories(saved?.memories??[]);effectiveStyle(config,memories);
  let state={version:1,stationId:saved?.stationId??randomUUID(),status:'off',activity:'idle',stage:'Station is off',error:null,config,memories,messages:Array.isArray(saved?.messages)?saved.messages.slice(-80):[],queue:[],currentTakeId:null,activeJobId:null,activeJob:null,session:null,pendingMessages:0};
  state.messages=state.messages.map(message=>['queued','sending'].includes(message.status)?{...message,status:'cancelled'}:message);
  for(const item of saved?.queue??[]){const take=await getTake(item.takeId);if(take)state.queue.push({takeId:take.id,title:take.title,duration:take.duration,audioUrl:take.audioUrl??`/api/takes/${take.id}/audio`,seed:take.request?.seed??''});}
  let pendingDraft=saved?.pendingDraft??null;
  if(pendingDraft){try{pendingDraft.request=validateRequest(pendingDraft.request);}catch{pendingDraft=null;}}
  // A process can finish between the last station poll and application shutdown.
  // Reconcile that completed take before treating its prepared draft as retryable.
  if(saved?.activeJobId){const previous=await getJob(saved.activeJobId);if(previous?.status==='completed'){const take=await getTake(previous.takeId??previous.id);if(take){if(!state.queue.some(item=>item.takeId===take.id))state.queue.push({takeId:take.id,title:take.title,duration:take.duration,audioUrl:take.audioUrl??`/api/takes/${take.id}/audio`,seed:take.request?.seed??state.config.seed});pendingDraft=null;}}}
  state.queue=state.queue.slice(0,3);
  let pending=[],revision=0,epoch=0,working=false,closed=false,controller=null,timer=null,flight=Promise.resolve(),writes=Promise.resolve();
  const snapshot=()=>clone({...state,pendingMessages:pending.length,preparedTitle:pendingDraft?.request.title??null});
  function save(){const document=clone({...state,pendingMessages:0,pendingDraft});writes=writes.then(async()=>{await fs.mkdir(dataRoot,{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(document,null,2),'utf8');await fs.rename(temporary,file);});return writes;}
  const note=(role,value,extra={})=>{const message={id:randomUUID(),role,text:value,at:timestamp(),...extra};state.messages.push(message);state.messages=state.messages.slice(-80);return message;};
  function kick(delay=0){if(closed)return;clearTimeout(timer);timer=setTimeout(()=>void pump().catch(()=>{}),delay);timer.unref?.();}
  function invalidatePrepared(){revision++;if(!state.activeJobId)pendingDraft=null;for(const item of pending){item.message.status='cancelled';}pending=[];if(state.activity==='host')controller?.abort();}
  function applyMemories(changes){const map=new Map(state.memories.map(item=>[item.key,item]));for(const change of changes){if(change.action==='forget')map.delete(change.key);else map.set(change.key,{key:change.key,value:change.value,updatedAt:timestamp()});}return checkedMemories([...map.values()]);}
  function pause(error){state.status='paused';state.activity='error';state.stage='Station paused';state.error=error?.message||'The station could not continue.';note('host',state.error,{error:true});}
  async function pump(){
    if(working||closed)return;working=true;const pumpEpoch=epoch;
    flight=(async()=>{
      if(state.activeJobId){
        const job=await getJob(state.activeJobId);
        if(epoch!==pumpEpoch)return;
        if(!job)throw new ApiError(502,'The station render could not be found. Its prepared draft is still saved.');
        state.activeJob={id:job.id,status:job.status,stage:job.stage,...(job.error?{error:job.error}:{})};
        if(['running','waiting'].includes(job.status)){state.activity=job.status==='waiting'?'waiting':'rendering';state.stage=job.stage;return;}
        const ownedId=state.activeJobId;state.activeJobId=null;state.activeJob=null;
        if(job.status!=='completed'){if(state.status==='off')return;throw new ApiError(502,job.error||`Radio rendering ${job.status}. The prepared draft can be retried with Start.`);}
        const take=await getTake(job.takeId??ownedId);if(!take)throw new ApiError(502,'The station finished rendering but its saved audio was not found.');
        if(!state.queue.some(item=>item.takeId===take.id))state.queue.push({takeId:take.id,title:take.title,duration:take.duration,audioUrl:take.audioUrl??`/api/takes/${take.id}/audio`,seed:take.request?.seed??state.config.seed});
        pendingDraft=null;if(state.session)state.session.createdTracks++;await save();
      }
      if(await isBusy()){if(state.status==='running'||pending.length){state.activity='waiting';state.stage='Waiting for the studio';}return;}
      if(state.status==='paused')return;
      if(pending.length){
        const item=pending.shift(),operationEpoch=epoch,operationRevision=revision;item.message.status='sending';state.activity='host';state.stage='Host is listening';controller=new AbortController();await save();
        try{
          const result=await chat({provider:state.config.provider,model:state.config.model,message:item.text,preferences:state.memories.map(({key,value})=>({key,value})),style:state.config.style,idea:state.config.idea},{signal:controller.signal});
          if(epoch!==operationEpoch||revision!==operationRevision){item.message.status='cancelled';return;}
          const host=validateRadioHostResult(result.host??result),nextMemories=applyMemories(host.memoryChanges);effectiveStyle({...state.config,...(host.style?{style:host.style}:{})},nextMemories);
          state.memories=nextMemories;if(host.style)state.config.style=host.style;
          if(host.memoryChanges.length||host.style){revision++;if(!state.activeJobId)pendingDraft=null;}
          item.message.status='sent';note('host',host.reply,{...(result.usage?{usage:result.usage}:{}),provider:state.config.provider,model:state.config.model});await save();
        }catch(error){if(controller.signal.aborted||epoch!==operationEpoch||revision!==operationRevision){item.message.status='cancelled';return;}item.message.status='failed';throw error;}finally{controller=null;}
        return;
      }
      if(state.status!=='running'){state.activity='idle';state.stage='Station is off';return;}
      if(state.config.maxTracksPerSession&&state.session.createdTracks>=state.config.maxTracksPerSession){state.status='off';state.activity='buffered';state.stage='Session track limit reached';await save();return;}
      const target=state.config.bufferAhead+(state.currentTakeId?0:1);
      if(state.queue.length>=target){state.activity='buffered';state.stage='Music is ready';return;}
      const operationEpoch=epoch,operationRevision=revision;
      if(!pendingDraft){
        state.activity='writing';state.stage='Writing the next song';controller=new AbortController();
        const preferenceSuffix=state.memories.length?'; Preference overrides: '+state.memories.map(item=>`${item.key}: ${item.value}`).join('; '):'';
        const creativeBrief={stationIdea:state.config.idea,pinnedStyle:state.config.style,preferences:state.memories.map(({key,value})=>({key,value})),trackNumber:state.session.createdTracks+1,variationId:randomUUID(),styleCharacterLimit:2000-preferenceSuffix.length,instruction:'Create fresh original lyrics, a distinctive title, and a fitting arrangement for this station. Keep the pinned genre and musical identity. Active listener preferences take precedence over conflicting details in the pinned style: explicitly avoid unwanted instruments, vocals, moods or themes. Write a concise complete style that reflects those preferences within styleCharacterLimit. Vary the imagery, hook and arrangement without drifting away from the station. Never reuse earlier songs.'};
        const idea=JSON.stringify(creativeBrief);if(idea.length>6000)throw new ApiError(400,'The combined station direction is too long. Shorten its idea, style or memories.');
        let result;try{result=await compose({provider:state.config.provider,model:state.config.model,idea,durationSeconds:state.config.durationSeconds},{signal:controller.signal});}catch(error){if(controller.signal.aborted||epoch!==operationEpoch||revision!==operationRevision)return;throw error;}finally{controller=null;}
        if(epoch!==operationEpoch||revision!==operationRevision||state.status!=='running')return;
        const song=validateSong(result.song??result),cap=state.config.durationSeconds*25;
        const request=validateRequest({...state.config.generation,title:song.title,lyrics:song.lyrics,style:arrangedStyle(song,state.memories),seed:state.config.seed,semantic_max_tokens:cap,semantic_min_tokens:Math.min(state.config.generation.semantic_min_tokens,cap),wait_for_memory:true});
        pendingDraft={id:randomUUID(),request,preparedAt:timestamp(),provider:state.config.provider,model:state.config.model,...(result.usage?{usage:result.usage}:{})};await save();
      }
      const engineBusy=await isBusy();
      if(epoch!==operationEpoch||revision!==operationRevision||state.status!=='running'||engineBusy||!pendingDraft)return;
      const draft=pendingDraft,metadata={radio:{stationId:state.stationId,sessionId:state.session.id,sequence:state.session.createdTracks+1,draftId:draft.id,provider:draft.provider,model:draft.model,preparedAt:draft.preparedAt,weightStorage:draft.request.weight_storage}};
      state.activity='rendering';state.stage='Starting the next track';
      const launched=await generate(clone(draft.request),metadata),job=launched.job??launched;
      if(!job?.id)throw new ApiError(502,'The station could not start its render. The prepared draft is saved.');
      if(epoch!==operationEpoch||revision!==operationRevision||state.status!=='running'){await cancelJob(job.id);return;}
      state.activeJobId=job.id;state.activeJob={id:job.id,status:job.status,stage:job.stage};state.activity=job.status==='waiting'?'waiting':'rendering';state.stage=job.stage||'Rendering the next song';await save();
    })().catch(async error=>{if(!closed&&epoch===pumpEpoch){pause(error);await save();}}).finally(()=>{working=false;if(!closed)kick(tickMs);});
    await flight;
  }
  async function configure(patch){const next=configuration(patch,state.config);effectiveStyle(next,state.memories);state.config=next;invalidatePrepared();await save();kick();return snapshot();}
  async function start(patch){if(closed)throw new ApiError(503,'The radio station is closing.');if(state.status==='running')return snapshot();if(patch){const next=configuration(patch,state.config);effectiveStyle(next,state.memories);if(JSON.stringify(next)!==JSON.stringify(state.config))invalidatePrepared();state.config=next;}validateSongwriterInput({provider:state.config.provider,model:state.config.model,idea:state.config.idea,durationSeconds:state.config.durationSeconds});if(!state.config.seed)state.config.seed=String(randomBytes(4).readUInt32LE());epoch++;state.status='running';state.error=null;state.activity='idle';state.stage='Tuning in';state.session={id:randomUUID(),createdTracks:0,startedAt:timestamp()};await save();kick();return snapshot();}
  async function stop(){
    const stoppedEpoch=++epoch;state.status='off';state.error=null;for(const item of pending)item.message.status='cancelled';pending=[];controller?.abort();
    const id=state.activeJobId,preparedAtStop=pendingDraft,sessionAtStop=state.session?.id;state.activeJobId=null;state.activeJob=null;
    if(id){
      await cancelJob(id);
      const job=await getJob(id);
      if(job?.status==='completed'){
        const take=await getTake(job.takeId??id);
        if(take){if(!state.queue.some(item=>item.takeId===take.id)){state.queue.push({takeId:take.id,title:take.title,duration:take.duration,audioUrl:take.audioUrl??`/api/takes/${take.id}/audio`,seed:take.request?.seed??state.config.seed});if(state.session?.id===sessionAtStop)state.session.createdTracks++;}if(pendingDraft===preparedAtStop)pendingDraft=null;}
      }
    }
    if(epoch===stoppedEpoch){state.activity='idle';state.stage='Station is off';}await save();return snapshot();
  }
  async function remember({key,value}){if(!validKey(key))throw new ApiError(400,'Memory keys use lowercase letters, numbers, underscores or hyphens.');value=text(value,500,'Remembered preference');const next=applyMemories([{action:'set',key,value}]);effectiveStyle(state.config,next);invalidatePrepared();state.memories=next;note('host',`Remembered ${key}: ${value}`);await save();kick();return snapshot();}
  async function forget(key){if(!validKey(key))throw new ApiError(400,'Choose a valid memory key.');invalidatePrepared();state.memories=state.memories.filter(item=>item.key!==key);note('host',`Forgot ${key}. Future writing uses the remaining active preferences.`);await save();kick();return snapshot();}
  async function resetMemories(){invalidatePrepared();state.memories=[];note('host','Remembered musical preferences cleared. The station idea and pinned style remain visible in its settings.');await save();kick();return snapshot();}
  async function message(input){const value=text(input?.text,6000,'Host message');
    if(value.startsWith('/')){
      const remembered=value.match(/^\/remember\s+([a-z][a-z0-9_-]{0,47})\s*=\s*(.+)$/s);if(remembered){note('user',value,{status:'sent'});return remember({key:remembered[1],value:remembered[2]});}
      const forgotten=value.match(/^\/forget\s+([a-z][a-z0-9_-]{0,47})$/);if(forgotten){note('user',value,{status:'sent'});return forget(forgotten[1]);}
      if(value==='/reset'){note('user',value,{status:'sent'});return resetMemories();}
      const style=value.match(/^\/style\s+(.+)$/s);if(style){const next=configuration({style:style[1]},state.config);effectiveStyle(next,state.memories);note('user',value,{status:'sent'});state.config=next;invalidatePrepared();note('host','Pinned station style updated. The next unwritten track will follow it.');await save();kick();return snapshot();}
      throw new ApiError(400,'Use /remember key=value, /forget key, /reset, or /style musical direction.');
    }
    if(pending.length>=8)throw new ApiError(429,'The host already has eight messages waiting. Let it catch up.');
    validateSongwriterInput({provider:state.config.provider,model:state.config.model,idea:value,durationSeconds:45});
    if(state.status==='paused'){state.status='off';state.error=null;}
    pending.push({text:value,message:note('user',value,{status:'queued'})});await save();kick();return snapshot();
  }
  async function consume(takeId){if(takeId===null){state.currentTakeId=null;}else{if(typeof takeId!=='string'||!state.queue.some(item=>item.takeId===takeId)){if(state.currentTakeId===takeId)return snapshot();throw new ApiError(404,'That radio track is not in the ready queue.');}state.queue=state.queue.filter(item=>item.takeId!==takeId);state.currentTakeId=takeId;}await save();kick();return snapshot();}
  async function removeTake(takeId){state.queue=state.queue.filter(item=>item.takeId!==takeId);if(state.currentTakeId===takeId)state.currentTakeId=null;if(state.activeJobId===takeId){state.activeJobId=null;state.activeJob=null;pendingDraft=null;}await save();kick();return snapshot();}
  async function close(){closed=true;clearTimeout(timer);await stop();await flight;await writes;}
  await save();
  return {snapshot,configure,start,stop,message,remember,forget,resetMemories,consume,removeTake,close,isRunning:()=>state.status==='running',ownsTake:id=>state.currentTakeId===id||state.queue.some(item=>item.takeId===id)};
}
