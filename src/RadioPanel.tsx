import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, Check, ChevronDown, ChevronUp, Clock3, History, LoaderCircle, MessageSquare, Pause, Play, Plus, Radio, RefreshCw, Send, Settings2, SkipForward, Square, Volume2, X } from 'lucide-react';
import { api, type GenerationRequest, timeLabel } from './types';
import SeedButton from './SeedButton';
import useRadioAudio from './useRadioAudio';
import type { RadioConfig, RadioModel, RadioProvider, RadioState, RadioWriterSettings } from './radioTypes';
import './radio.css';

interface Props {
  draft: GenerationRequest;
  onError: (message: string) => void;
  onTakesChanged: () => void;
  onActiveChange: (active: boolean) => void;
  blocked?: boolean;
}
const providerNames: Record<RadioProvider, string> = { ollama: 'Ollama', deepinfra: 'DeepInfra', openai: 'OpenAI' };
const activityNames = { idle: 'Standing by', host: 'The host is listening', writing: 'Writing the next song', rendering: 'Rendering the next take', waiting: 'Waiting for memory', buffered: 'The buffer is ready', error: 'Station needs attention' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const labelModel = (model: RadioModel) => `${model.label || model.name || model.id}${model.sizeBytes ? ` · ${(model.sizeBytes / 1e9).toFixed(1)} GB` : ''}`;

export default function RadioPanel({ draft, onError, onTakesChanged, onActiveChange, blocked = false }: Props) {
  const [open, setOpen] = useState(false);
  const [station, setStation] = useState<RadioState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [config, setConfig] = useState<RadioConfig>({ provider: 'ollama', model: '', idea: '', style: '', seed: '', durationSeconds: 45, bufferAhead: 1, maxTracksPerSession: 0, generation: { ...draft } });
  const [dirty, setDirty] = useState(false);
  const [settings, setSettings] = useState<RadioWriterSettings | null>(null);
  const [models, setModels] = useState<RadioModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [message, setMessage] = useState('');
  const [rememberOpen, setRememberOpen] = useState(false);
  const [memoryKey, setMemoryKey] = useState('');
  const [memoryValue, setMemoryValue] = useState('');
  const [newMessages, setNewMessages] = useState(false);
  const [prerollTarget, setPrerollTarget] = useState(0);
  const callbacks = useRef({ onError, onTakesChanged, onActiveChange }); callbacks.current = { onError, onTakesChanged, onActiveChange };
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const stateRef = useRef(station); stateRef.current = station;
  const knownTakes = useRef(new Set<string>());
  const initialized = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  const modelController = useRef<AbortController | null>(null);
  const currentProvider = useRef(config.provider); currentProvider.current = config.provider;

  const applyState = useCallback((radio: RadioState, syncConfig = false) => {
    setStation(radio);
    if (syncConfig || !dirtyRef.current) setConfig(radio.config);
    let added = false;
    for (const take of radio.queue || []) { if (initialized.current && !knownTakes.current.has(take.takeId)) added = true; knownTakes.current.add(take.takeId); }
    initialized.current = true;
    if (added) callbacks.current.onTakesChanged();
  }, []);
  const reportError = useCallback((text: string) => { setError(text); callbacks.current.onError(text); }, []);
  const consume = useCallback(async (takeId: string | null) => {
    try {
      const response = await api<{ radio: RadioState }>('/api/radio/consume', { method: 'POST', body: JSON.stringify({ takeId }) });
      applyState(response.radio);
    } catch (error) {
      const response = await api<{ radio: RadioState }>('/api/radio');
      applyState(response.radio);
      if (response.radio.currentTakeId !== takeId) throw error;
    }
  }, [applyState]);
  const audio = useRadioAudio({ queue: station?.queue || [], onConsume: consume, onError: reportError });
  const active = station?.status === 'running' || Boolean(station?.activeJobId) || busy === 'start' || busy === 'stop';
  const readyQueue = (station?.queue || []).filter(item => item.takeId !== audio.current?.takeId);
  const connected = Boolean(settings?.providers[config.provider]?.configured);
  const modelAvailable = models.some(item => item.id === config.model);
  const validSeed = config.seed === '' || /^\d+$/.test(config.seed) && Number(config.seed) <= 4294967295;
  const canStart = loaded && !blocked && !busy && connected && modelAvailable && Boolean(config.idea.trim()) && Boolean(config.style.trim()) && validSeed;
  const underbuffer = (audio.armed || prerollTarget > 0) && !audio.current && station?.status === 'running';
  const stage = station?.activity ? activityNames[station.activity] : 'Standing by';
  const stateLabel = audio.playing ? 'ON AIR' : prerollTarget ? 'BUILDING FIRST BUFFER' : underbuffer ? 'BUILDING BUFFER' : station?.status === 'running' ? 'STATION RUNNING' : station?.status === 'paused' ? 'PAUSED' : 'OFF';
  const createdCount = station?.session?.createdTracks || 0;

  useEffect(() => { callbacks.current.onActiveChange(Boolean(active)); }, [active]);
  useEffect(() => {
    if (station?.status !== 'running' && !audio.current && !readyQueue.length && audio.armed && !audio.transitioning) audio.pause();
  }, [station?.status, audio.current, readyQueue.length, audio.armed, audio.transitioning]);
  useEffect(() => {
    if (!prerollTarget) return;
    if (station?.error) { setPrerollTarget(0); return; }
    if (readyQueue.length >= prerollTarget) { setPrerollTarget(0); void audio.resume(); }
  }, [prerollTarget, readyQueue.length, station?.error]);
  useEffect(() => {
    const clearPreroll = () => setPrerollTarget(0);
    window.addEventListener('yue-manual-playing', clearPreroll);
    return () => window.removeEventListener('yue-manual-playing', clearPreroll);
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const controller = new AbortController();
    const poll = async () => {
      try { const response = await api<{ radio: RadioState }>('/api/radio', { signal: controller.signal }); if (stopped) return; applyState(response.radio); setLoaded(true); }
      catch (error) { if (!stopped) { setError(errorMessage(error)); setLoaded(true); } }
      if (!stopped) timer = window.setTimeout(poll, stateRef.current?.status === 'running' || open ? 1000 : 3000);
    };
    void poll();
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [open, applyState]);
  const discoverModels = useCallback(async (provider: RadioProvider) => {
    modelController.current?.abort(); const controller = new AbortController(); modelController.current = controller;
    setModelsLoading(true); setModelError(''); setModels([]);
    try {
      const response = await api<{ models: RadioModel[] }>(`/api/writer/models?provider=${provider}`, { signal: controller.signal });
      if (controller.signal.aborted || currentProvider.current !== provider) return;
      setModels(response.models);
      if (!response.models.length) setModelError(provider === 'ollama' ? 'No installed local text model was found. Add a model in Ollama, then refresh.' : 'No writing models were returned for this account.');
      if (provider === 'ollama' && response.models.length) setConfig(current => {
        if (current.model) return current;
        dirtyRef.current = true; setDirty(true);
        return { ...current, model: response.models.find(item => item.id === settings?.recommendedLocalModel)?.id || response.models[0].id };
      });
    } catch (error) { if (!controller.signal.aborted) setModelError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setModelsLoading(false); }
  }, [settings?.recommendedLocalModel]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ settings: RadioWriterSettings }>('/api/writer/settings', { signal: controller.signal }).then(response => { if (!controller.signal.aborted) setSettings(response.settings); }).catch(error => { if (!controller.signal.aborted) setModelError(errorMessage(error)); });
    return () => controller.abort();
  }, [open]);
  useEffect(() => {
    if (!open || !settings || !loaded) return;
    if (settings.providers[config.provider]?.configured) void discoverModels(config.provider);
    else { modelController.current?.abort(); setModels([]); setModelsLoading(false); setModelError(''); }
    return () => modelController.current?.abort();
  }, [open, config.provider, settings, loaded, discoverModels]);
  const latestMessageId = station?.messages?.at(-1)?.id;
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (stickToBottom.current) { node.scrollTop = node.scrollHeight; setNewMessages(false); }
    else setNewMessages(true);
  }, [latestMessageId, open]);

  function editConfig(patch: Partial<RadioConfig>) { dirtyRef.current = true; setDirty(true); setConfig(current => ({ ...current, ...patch })); }
  async function saveConfig() {
    if (busy || active || !validSeed) return;
    setBusy('save'); setError('');
    try { const response = await api<{ radio: RadioState }>('/api/radio/config', { method: 'PUT', body: JSON.stringify(config) }); dirtyRef.current = false; setDirty(false); applyState(response.radio, true); setNotice('Station settings saved. '); }
    catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  async function startStation() {
    if (!canStart) return;
    setBusy('start'); setError(''); setNotice('');
    try {
      const response = await api<{ radio: RadioState }>('/api/radio/start', { method: 'POST', body: JSON.stringify({ config }) });
      dirtyRef.current = false; setDirty(false); applyState(response.radio, true); setSettingsOpen(false);
      const target = Math.min(response.radio.config.bufferAhead + 1, response.radio.config.maxTracksPerSession || Infinity);
      if (audio.current || response.radio.queue.length >= target) await audio.resume();
      else setPrerollTarget(target);
    } catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  async function stopStation() {
    setPrerollTarget(0); audio.pause(); setBusy('stop'); setError('');
    try { const response = await api<{ radio: RadioState }>('/api/radio/stop', { method: 'POST', body: '{}' }); applyState(response.radio); setNotice('Station stopped. Ready takes, conversation and memories are kept.'); }
    catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  async function sendMessage(event?: React.FormEvent) {
    event?.preventDefault(); if (!message.trim() || busy) return;
    const text = message.trim(); setBusy('message'); setError('');
    try {
      if (dirtyRef.current && !active) {
        const saved = await api<{ radio: RadioState }>('/api/radio/config', { method: 'PUT', body: JSON.stringify(config) });
        dirtyRef.current = false; setDirty(false); applyState(saved.radio, true);
      }
      const response = await api<{ radio: RadioState }>('/api/radio/message', { method: 'POST', body: JSON.stringify({ text }) }); applyState(response.radio); setMessage(''); stickToBottom.current = true;
    }
    catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  async function remember() {
    if (!/^[a-z][a-z0-9_-]{0,47}$/.test(memoryKey) || !memoryValue.trim() || busy) return;
    setBusy('memory'); setError('');
    try { const response = await api<{ radio: RadioState }>('/api/radio/memories', { method: 'PUT', body: JSON.stringify({ key: memoryKey.trim(), value: memoryValue.trim().replace(/[\r\n]+/g, ' ') }) }); applyState(response.radio); setMemoryKey(''); setMemoryValue(''); setRememberOpen(false); }
    catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  async function forget(key: string) {
    if (busy) return;
    setBusy(`forget:${key}`); setError('');
    try { const response = await api<{ radio: RadioState }>(`/api/radio/memories/${encodeURIComponent(key)}`, { method: 'DELETE' }); applyState(response.radio); }
    catch (error) { reportError(errorMessage(error)); }
    finally { setBusy(null); }
  }
  function insertCommand(command: string) { setMessage(command); messageInput.current?.focus(); }
  async function refreshConnection() {
    try { const response = await api<{ settings: RadioWriterSettings }>('/api/writer/settings'); setSettings(response.settings); }
    catch (error) { setModelError(errorMessage(error)); }
  }
  const playingDuration = audio.duration || audio.current?.duration || 0;
  const progress = playingDuration ? Math.min(1, audio.position / playingDuration) : 0;

  return <section className={`radio-panel ${open ? 'radio-panel-open' : ''}`} data-radio-panel onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.stopPropagation(); }}>
    <button className="radio-disclosure" aria-expanded={open} onClick={() => setOpen(!open)}><Radio size={18} /><strong>Radio</strong><span className="radio-experimental">EXPERIMENTAL</span><span className="radio-disclosure-note">A station that follows your thread.</span><span className={`radio-disclosure-status ${active || audio.playing ? 'is-active' : ''}`}><i />{stateLabel}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
    {open && <div className="radio-body" aria-busy={!loaded}>
      <div className="radio-intro"><div><span className="eyebrow">AN OPEN-ENDED SESSION</span><h2>One song leads to another.</h2></div><button className="radio-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} />Station settings{dirty && <span className="radio-unsaved">Unsaved</span>}{settingsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button></div>
      {settingsOpen && <div className="radio-setup">
        <fieldset disabled={!loaded || Boolean(busy) || Boolean(active)}>
          <div className="radio-brief-grid"><label><span>STATION IDEA</span><textarea aria-label="Radio station idea" spellCheck={true} value={config.idea} maxLength={1500} onChange={event => editConfig({ idea: event.target.value })} placeholder="A midnight station for strange, beautiful songs. Stories overheard on the last train; warm rap verses, small sung hooks, and details that don't quite add up." /></label><label><span>SOUND BASELINE<button type="button" className="radio-import" disabled={!draft.style.trim()} onClick={() => { editConfig({ style: draft.style, generation: { ...draft } }); setNotice('Copied your current sound direction and rendering settings. The main composition is unchanged.'); }}><ArrowDownLeft size={13} />Use current sound & settings</button></span><textarea aria-label="Radio sound baseline" spellCheck={true} value={config.style} maxLength={2000} onChange={event => editConfig({ style: event.target.value })} placeholder="Nocturnal jazz rap, 90 BPM, clearly rapped verses, restrained sung hooks, dusty keys and a rounded bass. Spacious, detailed production." /></label></div>
          <div className="radio-provider-grid"><label><span>Host provider</span><select aria-label="Radio host provider" value={config.provider} onChange={event => editConfig({ provider: event.target.value as RadioProvider, model: '' })}>{Object.entries(providerNames).map(([id, name]) => <option key={id} value={id}>{name}{id === 'ollama' ? ' · local' : ' · API account'}</option>)}</select></label><label className="radio-model-field"><span>Host model</span><div><select aria-label="Radio host model" value={modelAvailable ? config.model : ''} disabled={modelsLoading || !connected || !models.length} onChange={event => editConfig({ model: event.target.value })}><option value="">{modelsLoading ? 'Finding models…' : !connected ? 'Connect this provider first' : 'Choose a writing model'}</option>{models.map(model => <option value={model.id} key={model.id}>{labelModel(model)}</option>)}</select><button type="button" aria-label="Refresh radio models" disabled={modelsLoading} onClick={() => void refreshConnection()}>{modelsLoading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button></div></label><label><span>Stable station seed</span><input aria-label="Radio station seed" inputMode="numeric" value={config.seed} placeholder="Pin a random seed on Start" onChange={event => { if (/^\d*$/.test(event.target.value)) editConfig({ seed: event.target.value }); }} /></label></div>
          <div className="radio-options-grid"><label><span>Song duration ceiling</span><select aria-label="Radio song duration" value={config.durationSeconds} onChange={event => editConfig({ durationSeconds: Number(event.target.value) })}>{![30, 45, 60, 90, 120, 180, 240, 360].includes(config.durationSeconds) && <option value={config.durationSeconds}>{config.durationSeconds} seconds</option>}{[30, 45, 60, 90, 120, 180, 240, 360].map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`}</option>)}</select></label><label><span>Prepare ahead</span><select aria-label="Radio buffer ahead" value={config.bufferAhead} onChange={event => editConfig({ bufferAhead: Number(event.target.value) })}><option value={1}>1 song ahead</option><option value={2}>2 songs ahead</option></select></label><label><span>Songs this session</span><input aria-label="Radio session song limit" type="number" min={0} max={1000} step={1} value={config.maxTracksPerSession} onChange={event => editConfig({ maxTracksPerSession: Number(event.target.value) })} /><small>0 keeps the station going until Stop.</small></label><div className="radio-render-baseline"><span>RENDERING BASELINE</span><strong>{config.generation?.num_inference_steps || 32} steps · {config.generation?.cot === 'off' ? 'Direct' : config.generation?.cot === 'melody' ? 'Melody' : 'Melody + chords'}</strong><small>{config.generation?.weight_storage === 'native' ? 'Original storage' : 'Efficient Q8'} · Waits for memory</small></div></div>
        </fieldset>
        {!connected && settings && <p className="radio-inline-note">Connect {providerNames[config.provider]} under <b>From an idea → Connection</b>, then refresh the model list here. Radio shares that saved connection.</p>}
        {modelError && <p className="radio-inline-error" role="alert">{modelError}</p>}
        {!validSeed && <p className="radio-inline-error" role="alert">Use a seed from 0 to 4294967295, or leave it blank to pin a random seed on Start.</p>}
        <div className="radio-setup-footer"><p>Duration is a ceiling. The station keeps the seed and sound baseline until you change them.</p><button className="radio-secondary" disabled={!dirty || Boolean(busy) || Boolean(active) || !validSeed} onClick={() => void saveConfig()}>{busy === 'save' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}Save station</button></div>
      </div>}

      <div className="radio-console">
        <div className="radio-console-top"><span><i className={audio.playing ? 'on' : ''} />{stateLabel}</span><span>{createdCount} {createdCount === 1 ? 'TAKE' : 'TAKES'} THIS SESSION <b>/</b> {config.maxTracksPerSession ? `${config.maxTracksPerSession} LIMIT` : 'UNTIL STOP'}</span></div>
        <div className="radio-now"><div className="radio-now-copy"><span className="radio-micro-label">{audio.current ? audio.playing ? 'NOW PLAYING' : 'ON THE DECK' : underbuffer ? 'BETWEEN SONGS' : 'READY WHEN YOU ARE'}</span><h3 title={audio.current?.title}>{audio.current?.title || (prerollTarget ? 'Building the first buffer.' : underbuffer ? 'The music is catching up.' : readyQueue.length ? 'Your next take is ready.' : 'A little room for the unexpected.')}</h3><p>{audio.current ? `${readyQueue.length} ${readyQueue.length === 1 ? 'song' : 'songs'} ready ahead${audio.playing && !readyQueue.length && station?.status === 'running' ? ' · the next take is still being made' : ''}` : prerollTarget ? `Waiting for ${prerollTarget} prepared songs (${readyQueue.length} ready). Press Play to join early.` : underbuffer ? station?.stage || stage : station?.status === 'running' ? 'Playback is paused. Press Play to join the station.' : 'Start a station, or play the takes already prepared.'}</p></div><div className="radio-clock"><strong>{timeLabel(audio.position)}</strong><span>/ {timeLabel(playingDuration)}</span></div></div>
        <div className="radio-progress" role="progressbar" aria-label="Radio track playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><div style={{ width: `${progress * 100}%` }} /><span style={{ left: `${progress * 100}%` }} /></div>
        <div className="radio-transport"><div><button className="radio-play" aria-label={audio.armed ? 'Pause radio playback' : 'Play radio playback'} disabled={!audio.current && !readyQueue.length && station?.status !== 'running'} onClick={() => { setPrerollTarget(0); if (audio.armed) audio.pause(); else void audio.resume(); }}>{audio.armed ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button><button className="radio-skip" aria-label="Skip radio song" disabled={audio.transitioning || !audio.current && !readyQueue.length} onClick={() => void audio.skip()}><SkipForward size={19} /></button><span className="radio-handover-note">{audio.transitioning ? 'CROSSFADING' : underbuffer ? 'WAITING FOR THE NEXT TAKE' : 'TWO DECKS · SOFT HANDOVERS'}</span></div><div className="radio-volume"><Volume2 size={15} /><input aria-label="Radio playback volume" type="range" min={0} max={1} step={.01} value={audio.volume} onChange={event => audio.setVolume(Number(event.target.value))} />{config.seed && <SeedButton seed={config.seed} tone="dark" onError={reportError} />}</div></div>
      </div>

      <div className="radio-queue"><div className="radio-queue-heading"><span>COMING THROUGH</span><span>{readyQueue.length} ready · {config.bufferAhead} {config.bufferAhead === 1 ? 'song' : 'songs'} ahead target</span></div>{readyQueue.map((take, index) => <div className="radio-queue-item" key={take.takeId}><span className="radio-queue-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{take.title}</strong><span>Ready to play</span></div><span>{timeLabel(take.duration)}</span><Check size={14} /></div>)}{station?.status === 'running' && station.activity !== 'buffered' && <div className="radio-queue-item radio-queue-in-progress"><span className="radio-queue-number">{station.activity === 'waiting' ? <Clock3 size={16} /> : <LoaderCircle size={16} className="spin" />}</span><div><strong>{stage}</strong><span>{station.activeJob?.stage || station.stage || 'The host is preparing the next part of the station.'}</span></div><span>{station.activity === 'waiting' ? 'WAITING' : station.activity === 'rendering' ? 'RENDERING' : station.activity === 'host' ? 'LISTENING' : 'WRITING'}</span></div>}{!readyQueue.length && station?.status !== 'running' && <p className="radio-empty-queue">Ready songs will appear here. Every finished song is also saved in the take register.</p>}</div>

      {(error || station?.error || notice) && <div className={`radio-notice ${error || station?.error ? 'radio-notice-error' : ''}`} role={error || station?.error ? 'alert' : 'status'}><span>{error || station?.error || notice}</span>{!station?.error && <button aria-label="Dismiss radio message" onClick={() => { setError(''); setNotice(''); }}><X size={14} /></button>}</div>}
      <div className="radio-start-line"><div><p>{config.provider === 'ollama' ? 'The host writes through your local Ollama server. Music is rendered on this computer.' : `Song drafts and free-text host messages use your ${providerNames[config.provider]} API credits. Send requests a reply; Start enables automatic song preparation.`}</p><span>{config.provider !== 'ollama' ? config.maxTracksPerSession ? `Automatic writing stops after ${config.maxTracksPerSession} songs this session, or when you press Stop.` : 'With no song limit, paid requests continue automatically until you press Stop.' : 'Generation may run slower than playback. A gap is shown honestly when the next take is not ready.'}{blocked && !active ? ' Finish or stop the manual generation before starting Radio.' : ''}</span></div>{active ? <button className="radio-stop-button" disabled={busy === 'stop' || busy === 'start'} onClick={() => void stopStation()}>{busy === 'stop' ? <LoaderCircle size={15} className="spin" /> : <Square size={13} fill="currentColor" />}{busy === 'stop' ? 'Stopping station…' : 'Stop station'}</button> : <button className="radio-start-button" disabled={!canStart} onClick={() => void startStation()}>{busy === 'start' ? <LoaderCircle size={15} className="spin" /> : <Radio size={16} />}{station?.status === 'paused' || createdCount ? 'Resume station' : 'Start station'}<ArrowRight size={15} /></button>}</div>

      <div className="radio-host-area"><section className="radio-conversation" aria-label="Radio host conversation"><div className="radio-section-heading"><div><MessageSquare size={16} /><h3>A word with the host.</h3></div><span>{station?.pendingMessages ? `${station.pendingMessages} PENDING` : 'CONVERSATION KEPT'}</span></div><div ref={transcript} className="radio-transcript" onScroll={event => { const node = event.currentTarget; stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 45; if (stickToBottom.current) setNewMessages(false); }} role="log" aria-label="Saved radio conversation" aria-live="polite" aria-relevant="additions">{station?.messages?.length ? station.messages.map(item => <article className={`radio-message radio-message-${item.role}`} key={item.id}><div><span>{item.role === 'user' ? 'YOU' : 'HOST'}</span><time>{new Date(item.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time>{item.status && item.status !== 'completed' && item.status !== 'done' && <i>{item.status}</i>}</div><p>{item.text}</p></article>) : <div className="radio-conversation-empty"><History size={21} strokeWidth={1.3} /><p>Tell the host where to go next.</p><span>A feeling, a scene, a change of pace. Your conversation and pinned memories stay with this station.</span></div>}</div>{newMessages && <button className="radio-new-messages" onClick={() => { if (transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight; stickToBottom.current = true; setNewMessages(false); }}>New messages <ChevronDown size={13} /></button>}<form className="radio-message-form" onSubmit={event => void sendMessage(event)}><div className="radio-command-shortcuts" aria-label="Radio host commands"><button type="button" onClick={() => insertCommand('/remember vocal_delivery=')}>/remember</button><button type="button" onClick={() => insertCommand('/forget ')}>/forget</button><button type="button" onClick={() => insertCommand('/style ')}>/style</button><button type="button" onClick={() => insertCommand('/reset')}>/reset</button></div><label><span className="radio-sr-only">Message the radio host</span><textarea ref={messageInput} aria-label="Message the radio host" spellCheck={true} value={message} maxLength={4000} placeholder="Keep the drums dry, but let the next song feel like sunrise…" onChange={event => setMessage(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void sendMessage(); } }} /></label><div><span>{station?.status === 'running' ? 'Guides the next unrendered song.' : 'The host replies using your selected model.'}</span><button type="submit" disabled={!loaded || !message.trim() || Boolean(busy)}>{busy === 'message' ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}Send</button></div></form></section>
        <section className="radio-memories" aria-label="Active radio memories"><div className="radio-section-heading"><div><h3>Things to keep.</h3></div><span>{station?.memories?.length || 0} ACTIVE</span></div><p className="radio-memory-intro">Visible notes the host carries into future songs. Forget a note to remove it from that context.</p><div className="radio-memory-list">{station?.memories?.length ? station.memories.map(memory => <article key={memory.key}><div><strong>{memory.key}</strong><button aria-label={`Forget memory ${memory.key}`} title="Forget this memory" disabled={Boolean(busy)} onClick={() => void forget(memory.key)}>{busy === `forget:${memory.key}` ? <LoaderCircle size={13} className="spin" /> : <X size={13} />}</button></div><p>{memory.value}</p></article>) : <p className="radio-no-memories">Nothing pinned yet.<span>Save a detail, a preference or a thread worth returning to.</span></p>}</div>{rememberOpen ? <div className="radio-remember-form"><label><span>Memory name</span><input aria-label="Radio memory name" spellCheck={false} value={memoryKey} maxLength={48} placeholder="vocal_delivery" onChange={event => setMemoryKey(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '_'))} /></label><label><span>What should stay?</span><textarea aria-label="Radio memory detail" spellCheck={true} value={memoryValue} maxLength={500} placeholder="Rap the verses clearly; keep sung lines for the hook." onChange={event => setMemoryValue(event.target.value)} /></label><div><button onClick={() => setRememberOpen(false)}>Cancel</button><button className="radio-secondary" disabled={!/^[a-z][a-z0-9_-]{0,47}$/.test(memoryKey) || !memoryValue.trim() || Boolean(busy)} onClick={() => void remember()}><Check size={13} />Remember</button></div></div> : <button className="radio-add-memory" onClick={() => setRememberOpen(true)}><Plus size={14} />Remember a detail</button>}<p className="radio-memory-footnote">Use <b>/reset</b> to clear the station's active memories. The conversation stays in the record.</p></section></div>
      <div className="radio-footer"><span>YUÈ RADIO <b>/</b> EXPERIMENTAL CONTINUOUS PLAY</span><span>No automatic playback after reopening.</span></div>
    </div>}
    <audio ref={node => { audio.decks.current[0] = node; }} preload="auto" onTimeUpdate={() => audio.onTimeUpdate(0)} onEnded={() => audio.onEnded(0)} onError={() => audio.audioError(0)} />
    <audio ref={node => { audio.decks.current[1] = node; }} preload="auto" onTimeUpdate={() => audio.onTimeUpdate(1)} onEnded={() => audio.onEnded(1)} onError={() => audio.audioError(1)} />
  </section>;
}
