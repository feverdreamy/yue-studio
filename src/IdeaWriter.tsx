import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronUp, Eye, EyeOff, LoaderCircle, PencilLine, RefreshCw, Settings2, Square, X } from 'lucide-react';
import { api } from './types';

type Provider = 'ollama' | 'deepinfra' | 'openai';
interface WriterSong { title: string; lyrics: string; style: string; }
interface ProviderState { configured: boolean; source?: 'none' | 'saved' | 'environment' | 'session'; }
interface WriterSettings {
  recommendedLocalModel?: string;
  ollamaBaseUrl: string;
  providers: Record<Provider, ProviderState>;
  secureStorage: boolean;
}
interface WriterModel { id: string; name?: string; label?: string; sizeBytes?: number; parameterSize?: string; quantization?: string; }
interface Preferences { provider: Provider; models: Partial<Record<Provider, string>>; idea: string; durationSeconds: number; }
interface Props { musicBusy: boolean; waitingForWriter: boolean; onBusyChange: (busy: boolean) => void; onApply: (song: WriterSong, durationSeconds: number) => void; }

const preferenceKey = 'yue-studio.writer-preferences.v1';
const durationOptions = [45, 60, 90, 120, 180, 240, 360];
const providers: { id: Provider; name: string; location: string }[] = [
  { id: 'ollama', name: 'Ollama', location: 'ON YOUR COMPUTER' },
  { id: 'deepinfra', name: 'DeepInfra', location: 'YOUR API ACCOUNT' },
  { id: 'openai', name: 'OpenAI', location: 'YOUR API ACCOUNT' },
];

function initialPreferences(): Preferences {
  const fallback: Preferences = { provider: 'ollama', models: {}, idea: '', durationSeconds: 180 };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
    if (!saved || typeof saved !== 'object') return fallback;
    return {
      provider: providers.some(provider => provider.id === saved.provider) ? saved.provider : 'ollama',
      models: Object.fromEntries(providers.filter(provider => typeof saved.models?.[provider.id] === 'string').map(provider => [provider.id, saved.models[provider.id]])),
      idea: typeof saved.idea === 'string' ? saved.idea.slice(0, 4000) : '',
      durationSeconds: durationOptions.includes(saved.durationSeconds) ? saved.durationSeconds : 180,
    };
  } catch { return fallback; }
}

function modelLabel(model: WriterModel) {
  const name = model.label || model.name || model.id;
  return `${name}${model.sizeBytes ? ` · ${(model.sizeBytes / 1e9).toFixed(1)} GB` : ''}`;
}

export default function IdeaWriter({ musicBusy, waitingForWriter, onBusyChange, onApply }: Props) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>(initialPreferences);
  const [settings, setSettings] = useState<WriterSettings | null>(null);
  const [models, setModels] = useState<WriterModel[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [error, setError] = useState('');
  const [modelError, setModelError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<WriterSong | null>(null);
  const [previewSource, setPreviewSource] = useState<{ provider: Provider; model: string; durationSeconds: number } | null>(null);
  const composeController = useRef<AbortController | null>(null);
  const modelsController = useRef<AbortController | null>(null);
  const activeProvider = useRef(preferences.provider);
  const ideaInput = useRef<HTMLTextAreaElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const provider = preferences.provider;
  activeProvider.current = provider;
  const providerInfo = providers.find(item => item.id === provider)!;
  const configured = Boolean(settings?.providers[provider]?.configured);
  const model = preferences.models[provider] || '';
  const modelAvailable = models.some(item => item.id === model);

  useEffect(() => {
    // Only this explicit non-secret preference shape ever enters browser storage.
    try { localStorage.setItem(preferenceKey, JSON.stringify({ provider: preferences.provider, models: preferences.models, idea: preferences.idea, durationSeconds: preferences.durationSeconds })); } catch { /* The writing panel also works without browser storage. */ }
  }, [preferences]);

  useEffect(() => () => { composeController.current?.abort(); modelsController.current?.abort(); onBusyChange(false); }, [onBusyChange]);

  const discoverModels = useCallback(async (target: Provider) => {
    modelsController.current?.abort();
    const controller = new AbortController(); modelsController.current = controller;
    setModelsLoading(true); setModelError(''); setModels([]);
    try {
      const response = await api<{ models: WriterModel[]; provider: Provider }>(`/api/writer/models?provider=${target}`, { signal: controller.signal });
      if (controller.signal.aborted || activeProvider.current !== target) return;
      setModels(response.models);
      if (!response.models.length) setModelError(target === 'ollama' ? 'No local models were found. Install a text model in Ollama, then refresh this list.' : 'This account returned no available writing models. Check its access, then refresh.');
      if (response.models.length === 1 || (target === 'ollama' && response.models.length)) setPreferences(current => current.models[target] ? current : { ...current, models: { ...current.models, [target]: response.models.find(item => target === 'ollama' && item.id === settings?.recommendedLocalModel)?.id || response.models[0].id } });
    } catch (error) {
      if (!controller.signal.aborted && activeProvider.current === target) setModelError(error instanceof Error ? error.message : 'The model list could not be loaded.');
    } finally { if (!controller.signal.aborted && activeProvider.current === target) setModelsLoading(false); }
  }, [settings?.recommendedLocalModel]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setSettingsLoading(true); setError('');
    void api<{ settings: WriterSettings }>('/api/writer/settings', { signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return;
      setSettings(response.settings); setBaseUrl(response.settings.ollamaBaseUrl);
    }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Writer settings could not be loaded.'); }).finally(() => { if (!controller.signal.aborted) setSettingsLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open || !settings) return;
    setApiKey(''); setShowKey(false); setModelError(''); setModels([]);
    if (settings.providers[provider]?.configured) void discoverModels(provider);
    else { modelsController.current?.abort(); setModelsLoading(false); setSettingsOpen(true); }
    return () => modelsController.current?.abort();
  }, [provider, open, settings, discoverModels]);

  async function saveConnection(remove = false) {
    if (savingSettings || busy) return;
    const target = provider;
    const body = target === 'ollama' ? { provider: target, baseUrl: baseUrl.trim() } : { provider: target, apiKey: remove ? '' : apiKey.trim() };
    if (target !== 'ollama' && !remove && !apiKey.trim()) { setError('Enter an API key to save this connection.'); return; }
    setSavingSettings(true); setError(''); setConnectionNotice('');
    try {
      const response = await api<{ settings: WriterSettings }>('/api/writer/settings', { method: 'PUT', body: JSON.stringify(body) });
      setApiKey(''); setShowKey(false); setSettings(response.settings); setBaseUrl(response.settings.ollamaBaseUrl);
      setConnectionNotice(remove ? 'The stored key was removed.' : target === 'ollama' ? 'Ollama address saved. Checking available models…' : response.settings.secureStorage ? 'Key saved securely on this computer.' : 'Key is available for this session only.');
    } catch (error) { setError(error instanceof Error ? error.message : 'The connection could not be saved.'); }
    finally { setSavingSettings(false); }
  }

  async function writeSong() {
    if (busy || musicBusy || waitingForWriter || !configured || !modelAvailable || !preferences.idea.trim()) return;
    const controller = new AbortController(); composeController.current = controller;
    const source = { provider, model, durationSeconds: preferences.durationSeconds };
    setBusy(true); onBusyChange(true); setError(''); setNotice('');
    try {
      const response = await api<{ song: WriterSong; provider: Provider; model: string }>('/api/writer/compose', { method: 'POST', body: JSON.stringify({ ...source, idea: preferences.idea.trim() }), signal: controller.signal });
      if (controller.signal.aborted) return;
      setPreview({ title: response.song.title, lyrics: response.song.lyrics, style: response.song.style });
      setPreviewSource({ ...source, provider: response.provider, model: response.model });
      window.setTimeout(() => previewHeading.current?.focus(), 0);
    } catch (error) {
      if (controller.signal.aborted) setNotice('Writing stopped. Your composition is unchanged.');
      else setError(error instanceof Error ? error.message : 'The writer could not finish this draft.');
    } finally { setBusy(false); onBusyChange(false); composeController.current = null; }
  }

  const credentialSource = settings?.providers[provider]?.source;

  return <section className={`idea-writer ${open ? 'idea-writer-open' : ''}`} data-writer-panel>
    <button className="writer-disclosure" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
      <span className="writer-mark"><PencilLine size={16} /></span><span className="writer-label">From an idea</span><span className="writer-disclosure-note">A small thought. A first draft.</span><span className="writer-disclosure-end">{open ? 'CLOSE WRITER' : 'OPEN WRITER'}{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
    </button>
    {open && <div className="writer-body">
      <div className="writer-workbench">
        <div className="writer-brief"><label className="writer-field-label" htmlFor="song-idea">WHAT IS THE SONG ABOUT?<span>Tell it like you would tell a collaborator.</span></label><textarea ref={ideaInput} id="song-idea" spellCheck={true} value={preferences.idea} onChange={event => setPreferences(current => ({ ...current, idea: event.target.value }))} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void writeSong(); } }} maxLength={4000} placeholder="A night-shift worker in a station’s lost-and-found. An old toy finds its way home, and he finally calls his brother. A warm, late-night rap with a small sung hook." /><div className="writer-brief-footer"><span>Include a story, feeling, genre or vocal delivery.</span><span>{preferences.idea.length}/4000</span></div></div>
        <div className="writer-routing">
          <div className="writer-field-label">YOUR WRITING PARTNER<button className={`writer-connection-toggle ${settingsOpen ? 'selected' : ''}`} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={13} /> Connection</button></div>
          <div className="writer-providers" role="group" aria-label="Songwriter provider">{providers.map(item => <button key={item.id} className={provider === item.id ? 'selected' : ''} aria-pressed={provider === item.id} disabled={busy || savingSettings} onClick={() => { setPreferences(current => ({ ...current, provider: item.id })); setError(''); setNotice(''); setConnectionNotice(''); }}><strong>{item.name}</strong><span>{item.location}</span></button>)}</div>
          <div className="writer-model-line"><label><span>Model</span><select aria-label="Writer model" value={modelAvailable ? model : ''} onChange={event => setPreferences(current => ({ ...current, models: { ...current.models, [provider]: event.target.value } }))} disabled={busy || modelsLoading || !configured || !models.length}><option value="">{modelsLoading ? 'Finding available models…' : !configured ? 'Connect this provider first' : 'Choose a writing model'}</option>{models.map(item => <option key={item.id} value={item.id}>{modelLabel(item)}</option>)}</select></label><button className="writer-refresh" aria-label="Refresh writing models" title="Refresh models and check connection" disabled={busy || modelsLoading || !configured} onClick={() => void discoverModels(provider)}>{modelsLoading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}</button><label className="writer-length"><span>Song length</span><select aria-label="Writer target song length" value={preferences.durationSeconds} disabled={busy} onChange={event => setPreferences(current => ({ ...current, durationSeconds: Number(event.target.value) }))}>{durationOptions.map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? `${seconds} seconds` : `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`}</option>)}</select></label></div>
          {modelError && <p className="writer-inline-error" role="alert">{modelError}</p>}
          {!modelsLoading && !modelError && model && !modelAvailable && configured && <p className="writer-hint">Your previous model is not in this list. Choose an available model.</p>}
          <p className="writer-destination">{provider === 'ollama' ? 'Writes through your Ollama server. No hosted writing account is needed.' : `Pressing Write sends your idea to ${providerInfo.name} through your API account and may incur its usage charges.`} <span>YuE audio generation stays on this computer.</span></p>
        </div>
      </div>

      {settingsOpen && <div className="writer-connection"><div className="writer-connection-heading"><div><span className={`status-dot ${configured ? 'ready' : ''}`} /><strong>{providerInfo.name} connection</strong><span>{settingsLoading ? 'Checking…' : configured ? credentialSource === 'environment' ? 'Environment key available' : provider === 'ollama' ? 'Local endpoint' : 'Key available' : 'Not connected'}</span></div><button className="icon-button" aria-label="Close writer connection settings" onClick={() => setSettingsOpen(false)}><X size={15} /></button></div>{provider === 'ollama' ? <div className="writer-credential-row"><label><span>Ollama address</span><input type="url" aria-label="Ollama server address" value={baseUrl} placeholder="http://127.0.0.1:11434" disabled={savingSettings || busy} onChange={event => setBaseUrl(event.target.value)} /></label><button className="writer-secondary-button" disabled={savingSettings || busy || !baseUrl.trim()} onClick={() => void saveConnection()}>{savingSettings ? <LoaderCircle size={14} className="spin" /> : null}Save & check</button></div> : <div className="writer-credential-row"><label><span>{providerInfo.name} API key</span><div className="writer-secret-field"><input type={showKey ? 'text' : 'password'} name="writer-provider-key" aria-label={`${providerInfo.name} API key`} autoComplete="off" spellCheck={false} value={apiKey} placeholder={configured ? 'Enter a replacement key' : 'Enter your API key'} disabled={savingSettings || busy} onChange={event => setApiKey(event.target.value)} /><button aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label><button className="writer-secondary-button" disabled={savingSettings || busy || !apiKey.trim()} onClick={() => void saveConnection()}>{savingSettings ? <LoaderCircle size={14} className="spin" /> : null}{settings?.secureStorage ? 'Save key' : 'Use for this session'}</button>{(credentialSource === 'saved' || credentialSource === 'session') && <button className="writer-remove-key" disabled={savingSettings || busy} onClick={() => void saveConnection(true)}>Remove stored key</button>}</div>}<p className="writer-connection-note">{provider === 'ollama' ? 'Keep Ollama running and install a text model. Refresh the model list after adding one.' : settings?.secureStorage ? 'Stored keys are encrypted by the desktop app. They are never included in drafts, takes or browser storage.' : 'This browser session cannot securely store keys on disk. Keys are held only for this server session and never saved in browser storage.'}</p>{connectionNotice && <p className="writer-connection-success" role="status"><Check size={13} />{connectionNotice}</p>}</div>}

      {(error || notice) && <div className={`writer-message ${error ? 'writer-message-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label="Dismiss writer message" onClick={() => { setError(''); setNotice(''); }}><X size={14} /></button></div>}

      <div className="writer-action-line"><p>{waitingForWriter && !busy ? 'The writer is releasing its model. Audio generation will be available shortly.' : musicBusy ? 'Finish or stop the current audio take before writing a new song.' : busy ? `Writing with ${providerInfo.name}. Your composition remains editable.` : 'The writer prepares lyrics and sound direction. You review the result before using it.'}</p>{busy ? <button className="writer-secondary-button writer-stop" onClick={() => composeController.current?.abort()}><Square size={12} fill="currentColor" /> Stop writing</button> : <button className="writer-write-button" disabled={musicBusy || waitingForWriter || settingsLoading || savingSettings || modelsLoading || !configured || !modelAvailable || !preferences.idea.trim()} onClick={() => void writeSong()}><PencilLine size={15} />{preview ? 'Write another draft' : 'Write a first draft'}<ArrowRight size={15} /></button>}</div>

      {preview && <div className="writer-preview"><div className="writer-preview-heading"><div><span className="eyebrow">THE FIRST DRAFT</span><h3 ref={previewHeading} tabIndex={-1}>Make these words your own.</h3></div><span>{providers.find(item => item.id === previewSource?.provider)?.name} <b>·</b> {previewSource?.model}</span></div><label className="writer-preview-title"><span>Title</span><input aria-label="Writer draft title" spellCheck={true} value={preview.title} maxLength={160} onChange={event => setPreview(current => current ? { ...current, title: event.target.value } : null)} /></label><div className="writer-preview-editors"><label><span>LYRICS & STRUCTURE</span><textarea aria-label="Writer draft lyrics" spellCheck={true} value={preview.lyrics} onChange={event => setPreview(current => current ? { ...current, lyrics: event.target.value } : null)} /></label><label><span>SOUND DIRECTION</span><textarea aria-label="Writer draft style" spellCheck={true} value={preview.style} onChange={event => setPreview(current => current ? { ...current, style: event.target.value } : null)} /><p>The target length sets a generation ceiling. YuE can finish earlier.</p></label></div><div className="writer-preview-actions"><p>Your existing composition is preserved until you apply this draft.</p><div><button className="text-button" disabled={busy} onClick={() => { setPreview(null); setPreviewSource(null); }}>Discard draft</button><button className="writer-apply-button" disabled={busy || !preview.title.trim() || !preview.lyrics.trim() || !preview.style.trim()} onClick={() => { onApply(preview, previewSource?.durationSeconds || preferences.durationSeconds); setPreview(null); setPreviewSource(null); setOpen(false); }}><Check size={15} /> Use this draft</button></div></div></div>}
    </div>}
  </section>;
}



