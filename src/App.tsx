import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, ChevronUp, CircleHelp, Copy, FileMusic, Headphones, ListMusic, LoaderCircle, Plus, Search, Settings2, Square, Star, Trash2, X } from 'lucide-react';
import Player from './Player';
import ScoreInput from './ScoreInput';
import Advanced from './Advanced';
import SeedButton from './SeedButton';
import IdeaWriter from './IdeaWriter';
import GenerationHistory from './GenerationHistory';
import GenerationProgress from './GenerationProgress';
import ResourceStrip from './ResourceStrip';
import RadioPanel from './RadioPanel';
import TrashPanel, {type TrashEntry} from './TrashPanel';
import { api, type CompositionMode, defaults, type GenerationRequest, type Job, type StudioStatus, type Take, timeLabel } from './types';

const modes: { value: CompositionMode; label: string; description: string }[] = [
  { value: 'off', label: 'Direct', description: 'Go straight from lyrics and sound direction to audio.' },
  { value: 'melody', label: 'Melody', description: 'Plan a melody first, then turn it into a performance.' },
  { value: 'full', label: 'Melody + chords', description: 'Plan melody and harmony before creating the full song.' },
];

const startingPoints = [
  { name: 'After hours', title: 'After hours', style: 'English, nocturnal dream pop, slow 78 BPM, intimate breathy lead vocal, detuned electric piano, warm tape textures, soft brushed drums, a deep rounded bass. Small and lonely in the verse, opening into a luminous, bittersweet chorus. Spacious, detailed stereo production.', lyrics: '[Verse]\nThe last train leaves a line of light\nAlong the edge of half past night\nYour voice is somewhere in the rain\nA song I cannot name\n\n[Chorus]\nLet the city turn to blue\nI am still a room for you\nEvery window holds a star\nEvery silence knows where you are' },
  { name: 'Uncanny ritual', title: 'A room remembers', style: 'English, eerie art folk and dark ambient, slow ritual pulse, fragile close-miked voice, bowed metal, detuned upright piano, distant choral harmonies, irregular quiet percussion. Beautiful but deeply uncanny, intimate and mournful, slowly intensifying. No bombastic trailer drums.', lyrics: '[Verse]\nThere is a room beneath the room\nA little light that has no moon\nThe walls remember every name\nAnd breathe them back to me again\n\n[Chorus]\nWho was here before the door\nWho is sleeping in the floor\nLeave a little silence on\nSo the house can carry on' },
  { name: 'First light', title: 'First light', style: 'English, intimate acoustic folk, fingerpicked nylon-string guitar, subtle upright bass, a warm natural lead voice, gentle room ambience, hopeful and unhurried. Start sparse, introduce delicate strings for the chorus. Organic, beautifully recorded live performance.', lyrics: '[Verse]\nMorning gathers on the sill\nThe world is turning, we are still\nA kettle sings against the cold\nAnother ordinary day of gold\n\n[Chorus]\nLet the light come slowly in\nLet the good things start again\nThere is nothing we must prove\nOnly room enough to move' },
  { name: 'Night drive', title: 'Night drive', style: 'English, sophisticated electronic pop, 112 BPM, dry intimate vocal, tight breakbeat, warm analog bass, glassy arpeggios, shimmering restrained pads. Elegant late-night momentum, memorable melodic chorus, clear modern mix with wide stereo atmosphere.', lyrics: '[Verse]\nWhite lines slip beneath the wheels\nNothing stays and nothing heals\nStill the radio is on\nStill we travel toward the dawn\n\n[Chorus]\nDrive until the dark is through\nSomewhere waits a different blue\nAll the roads we never knew\nLead me back to something new' },
];

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

declare global { interface Window { yueStudioFlushDraft?: () => Promise<void>; } }

export default function App() {
  const [request, setRequest] = useState<GenerationRequest>(defaults);
  const [status, setStatus] = useState<StudioStatus | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [libraryTab, setLibraryTab] = useState<'takes' | 'history' | 'trash'>('takes');
  const [trashRevision,setTrashRevision]=useState(0);
  const [deletedItem,setDeletedItem]=useState<TrashEntry|null>(null);
  const [deleteBusy,setDeleteBusy]=useState(false);
  const [libraryError,setLibraryError]=useState('');
  const [radioActive,setRadioActive]=useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [writerBusy, setWriterBusy] = useState(false);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [engineOpen, setEngineOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [previousDraft, setPreviousDraft] = useState<GenerationRequest | null>(null);
  const [notice, setNotice] = useState('');
  const savedSnapshot = useRef('');
  const saveRevision = useRef(0);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimer = useRef<number | undefined>(undefined);
  const latestRequest = useRef(request);
  latestRequest.current = request;
  const completedJobs = useRef(new Set<string>());
  const titleInput = useRef<HTMLInputElement>(null);
  const active = job?.status === 'running' || job?.status === 'waiting' || status?.activeJob?.status === 'running' || status?.activeJob?.status === 'waiting';
  const waiting = (status?.activeJob || job)?.status === 'waiting';
  const writing = writerBusy || Boolean(status?.writerBusy);
  const radioBusy=radioActive||Boolean(status?.radioActive);
  const selectedTake = takes.find(take => take.id === selectedId) || null;
  const mode = modes.find(item => item.value === request.cot)!;
  const words = request.lyrics.trim() ? request.lyrics.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).length : 0;
  const sections = (request.lyrics.match(/^\s*\[[^\]]+\]/gm) || []).length;

  const update = useCallback((updates: Partial<GenerationRequest>) => setRequest(current => ({ ...current, ...updates })), []);
  const handleWriterBusy = useCallback((busy: boolean) => {
    if (busy) { setWriterBusy(true); return; }
    // Refresh the server reservation before re-enabling audio after cancellation.
    void api<StudioStatus>('/api/status').then(next => setStatus(next)).catch(() => setConnectionError('Connection to the local engine was interrupted. Reconnecting…')).finally(() => setWriterBusy(false));
  }, []);
  const loadTakes = useCallback(async (select?: string) => {
    const result = await api<{ takes: Take[] }>('/api/takes');
    setTakes(result.takes);
    if (select) setSelectedId(select);
    else setSelectedId(current => current || result.takes[0]?.id || null);
  }, []);
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { const result = await api<{ jobs: Job[] }>('/api/jobs'); setHistory(result.jobs); setHistoryError(''); return result.jobs; }
    catch (error) { setHistoryError(errorText(error)); throw error; }
    finally { setHistoryLoading(false); }
  }, []);
  const refreshLibrary=useCallback(()=>{void loadTakes().catch(error=>setError(errorText(error)));void loadHistory().catch(()=>{});setTrashRevision(value=>value+1);},[loadTakes,loadHistory]);
  async function deleteItem(kind:'takes'|'jobs',id:string){
    if(deleteBusy)return;setDeleteBusy(true);setLibraryError('');
    try{const result=await api<{entry:TrashEntry}>(`/api/${kind}/${id}`,{method:'DELETE'});setDeletedItem(result.entry);if(kind==='takes'){window.dispatchEvent(new CustomEvent('yue-take-deleted',{detail:{id}}));if(selectedId===id)setSelectedId(null);}if(kind==='jobs'&&job?.id===id)setJob(null);refreshLibrary();}
    catch(error){setLibraryError(errorText(error));}finally{setDeleteBusy(false);}
  }
  async function undoDelete(){if(!deletedItem)return;setDeleteBusy(true);setLibraryError('');try{await api(`/api/trash/${deletedItem.id}/restore`,{method:'POST',body:'{}'});setDeletedItem(null);refreshLibrary();}catch(error){setLibraryError(errorText(error));}finally{setDeleteBusy(false);}}
  useEffect(() => { if (libraryOpen) void loadHistory().catch(() => undefined); }, [libraryOpen, loadHistory]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const results = await Promise.allSettled([
        api<{ defaults: GenerationRequest }>('/api/defaults'), api<{ draft: Partial<GenerationRequest> | null }>('/api/draft'),
        api<StudioStatus>('/api/status'), api<{ takes: Take[] }>('/api/takes'), api<{ jobs: Job[] }>('/api/jobs'),
      ]);
      if (!alive) return;
      const base = results[0].status === 'fulfilled' ? results[0].value.defaults : defaults;
      const draft = results[1].status === 'fulfilled' ? results[1].value.draft || {} : {};
      const merged = { ...defaults, ...base, semantic_max_tokens: 1125, ...draft };
      merged.seed = merged.seed == null ? '' : String(merged.seed);
      setRequest(merged); savedSnapshot.current = JSON.stringify(merged);
      if (results[2].status === 'fulfilled') { setStatus(results[2].value); setJob(results[2].value.activeJob); }
      else setConnectionError('The local engine is not responding. Start the studio launcher, then refresh.');
      if (results[3].status === 'fulfilled') { setTakes(results[3].value.takes); setSelectedId(results[3].value.takes[0]?.id || null); }
      if (results[4].status === 'fulfilled') { setHistory(results[4].value.jobs); if (results[2].status === 'fulfilled' && !results[2].value.activeJob) setJob(results[4].value.jobs[0] || null); }
      setScoreOpen(Boolean(merged.abc));
      setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!loaded || savedSnapshot.current === JSON.stringify(request)) return;
    const revision = ++saveRevision.current;
    setSaving('saving');
    const timer = window.setTimeout(() => {
      saveQueue.current = saveQueue.current.catch(() => undefined).then(() => api('/api/draft', { method: 'PUT', body: JSON.stringify({ draft: request }) })).then(() => { savedSnapshot.current = JSON.stringify(request); if (saveRevision.current === revision) setSaving('saved'); }).catch(() => { if (saveRevision.current === revision) setSaving('error'); });
    }, 700);
    saveTimer.current = timer;
    return () => window.clearTimeout(timer);
  }, [request, loaded]);

  useEffect(() => {
    window.yueStudioFlushDraft = async () => {
      if (!loaded) return;
      window.clearTimeout(saveTimer.current);
      await saveQueue.current.catch(() => undefined);
      const snapshot = JSON.stringify(latestRequest.current);
      if (snapshot === savedSnapshot.current) return;
      const revision = ++saveRevision.current;
      setSaving('saving');
      const pending = api('/api/draft', { method: 'PUT', body: JSON.stringify({ draft: latestRequest.current }) });
      saveQueue.current = pending;
      try { await pending; savedSnapshot.current = snapshot; if (saveRevision.current === revision) setSaving('saved'); }
      catch (error) { setSaving('error'); throw error; }
    };
    return () => { delete window.yueStudioFlushDraft; };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const flush = () => {
      if (savedSnapshot.current === JSON.stringify(request)) return;
      void fetch('/api/draft', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: request }), keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [request, loaded]);

  useEffect(() => {
    if (!libraryOpen && !engineOpen && !helpOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const selector = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const elements = Array.from(dialog.querySelectorAll<HTMLElement>(selector)).filter(element => element.offsetParent !== null);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [libraryOpen, engineOpen, helpOpen]);

  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    let timer: number;
    async function poll() {
      try {
        const nextStatus = await api<StudioStatus>('/api/status');
        if (stopped) return;
        setStatus(nextStatus); setConnectionError('');
        let nextJob = nextStatus.activeJob;
        if (!nextJob && (job?.status === 'running' || job?.status === 'waiting')) nextJob = (await api<{ job: Job }>(`/api/jobs/${job.id}`)).job;
        if (stopped) return;
        if (nextJob) {
          setJob(nextJob);
          if (nextJob.status === 'completed' && !completedJobs.current.has(nextJob.id)) {
            completedJobs.current.add(nextJob.id); await loadTakes(nextJob.takeId); setNotice('A new take is ready to listen.');
          }
          if (nextJob.status === 'failed') setError(nextJob.error || 'The local engine could not finish this take. Open the generation log for details.');
          if (nextJob.status === 'cancelled') setNotice('Generation stopped. Your draft is preserved.');
          if (nextJob.status !== 'waiting' && nextJob.status !== 'running') void loadHistory().catch(() => undefined);
        }
      } catch { if (!stopped) setConnectionError('Connection to the local engine was interrupted. Reconnecting…'); }
      if (!stopped) timer = window.setTimeout(poll, active || writing ? 1000 : 3000);
    }
    timer = window.setTimeout(poll, active || writing ? 500 : 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [loaded, active, writing, job?.id, job?.status, loadTakes, loadHistory]);

  const generate = useCallback(async (preview = false) => {
    if (submitting || active || writing || radioBusy || !status?.ready) return;
    if (!request.lyrics.trim() || !request.style.trim()) { setError('Add your lyrics and sound direction before composing.'); return; }
    if (request.seed && (Number(request.seed) > 4294967295 || Number(request.seed) < 0)) { setError('Use a seed between 0 and 4294967295, or leave it blank for a new seed.'); setAdvanced(true); return; }
    for (const prefix of ['abc', 'semantic'] as const) {
      if (request[`${prefix}_min_tokens`] > request[`${prefix}_max_tokens`]) { setError(`${prefix === 'abc' ? 'Score planning' : 'Musical sampling'}: minimum tokens must not exceed maximum tokens.`); setAdvanced(true); return; }
      if (request[`${prefix}_temperature`] <= 0 || request[`${prefix}_temperature`] > 5 || request[`${prefix}_top_p`] <= 0 || request[`${prefix}_top_p`] > 1) { setError('Temperature must be above 0 and at most 5. Top P must be above 0 and at most 1.'); setAdvanced(true); return; }
    }
    setSubmitting(true); setError(''); setNotice('');
    try {
      const title = request.title.trim() || 'Untitled composition';
      const result = await api<{ job: Job }>('/api/generate', { method: 'POST', body: JSON.stringify({ ...request, abc: request.cot === 'off' ? '' : request.abc, title: preview ? `${title.slice(0, 150)} · preview` : title, ...(preview ? { semantic_max_tokens: 750, semantic_min_tokens: Math.min(request.semantic_min_tokens, 750) } : {}) }) });
      setJob(result.job);
      void loadHistory().catch(() => undefined);
    } catch (err) { setError(errorText(err)); }
    finally { setSubmitting(false); }
  }, [request, active, status?.ready, submitting, writing, radioBusy, loadHistory]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target instanceof Element && event.target.closest('[data-writer-panel], [data-radio-panel]')) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void generate(); }
      if (event.key === 'Escape') { setLibraryOpen(false); setEngineOpen(false); setHelpOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [generate]);

  async function cancel() {
    const id = job?.id || status?.activeJob?.id;
    if (!id || submitting) return;
    setSubmitting(true);
    try { const result = await api<{ job: Job }>(`/api/jobs/${id}/cancel`, { method: 'POST' }); if (result.job) setJob(result.job); setNotice(result.job?.status === 'cancelled' ? 'Generation stopped. Your draft is preserved.' : 'Stopping generation… Your draft is preserved.'); }
    catch (err) { setError(errorText(err)); }
    finally { setSubmitting(false); }
  }
  async function favorite(take: Take) {
    try {
      await api(`/api/takes/${take.id}`, { method: 'PATCH', body: JSON.stringify({ favorite: !take.favorite }) });
      setTakes(current => current.map(item => item.id === take.id ? { ...item, favorite: !item.favorite } : item));
    } catch (err) { setError(errorText(err)); }
  }
  function useTake(take: Take) {
    setPreviousDraft(request); setRequest({ ...defaults, ...take.request, weight_storage: take.request.weight_storage ?? 'native', title: `${take.title} · variation`, seed: String(take.request.seed ?? '') });
    setScoreOpen(Boolean(take.request.abc)); setLibraryOpen(false); setNotice('Take settings loaded. Change the seed for a new interpretation.');
  }
  async function restoreAttempt(attempt: Job) {
    setSubmitting(true);
    try {
      const recorded = attempt.request || history.find(item => item.id === attempt.id)?.request || (await loadHistory()).find(item => item.id === attempt.id)?.request;
      if (!recorded) throw new Error('The saved settings for this attempt could not be found. Refresh the generation history and try again.');
      setPreviousDraft(request); setRequest({ ...defaults, ...recorded, weight_storage: recorded.weight_storage ?? 'native', seed: String(recorded.seed ?? attempt.seed ?? '') });
      setScoreOpen(Boolean(recorded.abc)); setLibraryOpen(false); setError(''); setNotice('Original words, settings and seed restored. Your previous draft can be recovered.');
    } catch (error) { setError(errorText(error)); }
    finally { setSubmitting(false); }
  }
  async function retryAttempt(attempt: Job) {
    if (active || writing || radioBusy || submitting || !status?.ready) return;
    setSubmitting(true); setError('');
    try {
      const result = await api<{ job: Job }>(`/api/jobs/${attempt.id}/retry`, { method: 'POST', body: JSON.stringify({ wait_for_memory: request.wait_for_memory }) });
      setJob(result.job); setLibraryOpen(false); setNotice('Retry saved with the original settings and seed. Your current draft is unchanged.'); void loadHistory().catch(() => undefined);
    } catch (error) { setError(errorText(error)); }
    finally { setSubmitting(false); }
  }
  function openHistory() { setLibraryTab('history'); setLibraryOpen(true); }
  function chooseMode(value: CompositionMode) {
    update({ cot: value, cfg_scale: request.cfg_scale === 1 || request.cfg_scale === 1.01 ? value === 'off' ? 1.01 : 1 : request.cfg_scale });
  }
  function newDraft() {
    setPreviousDraft(request); setRequest({ ...request, title: '', lyrics: '', style: '', abc: '', seed: '' }); setScoreOpen(false); setNotice('A fresh composition. Your previous draft can be restored.'); titleInput.current?.focus();
  }
  const filteredTakes = takes.filter(take => (!favoritesOnly || take.favorite) && `${take.title} ${take.request.style}`.toLowerCase().includes(search.toLowerCase()));
  const currentJob = status?.activeJob || job;

  return <div className="studio-shell">
    <header className="app-header">
      <a className="brand" href="#" aria-label="YuE Studio home"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 9v14M12 5v22M19 11v10M26 7v18" /></svg><span>yuè<span className="brand-period">.</span></span><small>STUDIO<br />COMPOSITION ENGINE 02</small></a>
      <div className="header-actions"><span className={`save-status ${saving === 'error' ? 'save-error' : ''}`}>{saving === 'saving' ? <LoaderCircle size={12} className="spin" /> : saving === 'saved' ? <Check size={12} /> : null}{!loaded ? 'Opening session' : saving === 'saved' ? 'Draft saved locally' : saving === 'saving' ? 'Saving draft' : 'Draft not saved'}</span><button className="engine-status" onClick={() => setEngineOpen(true)}><span className={`status-dot ${status?.ready && !connectionError ? 'ready' : ''}`} />{waiting ? 'WAITING FOR MEMORY' : active ? 'ENGINE WORKING' : status?.ready && !connectionError ? 'ENGINE READY' : 'ENGINE SETUP'}<ChevronDown size={12} /></button><button className="icon-button help-button" aria-label="Studio guide" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /></button></div>
    </header>

    <main inert={!loaded} aria-busy={!loaded}>
      <div className="composition-heading"><div><div className="eyebrow">YOUR COMPOSITION <span>—</span> LOCAL SESSION</div><input ref={titleInput} className="composition-title" aria-label="Composition title" spellCheck={true} placeholder="Untitled composition" value={request.title} onChange={e => update({ title: e.target.value })} maxLength={160} /></div><div className="heading-tools"><button className="text-button" onClick={newDraft}><Plus size={15} /> New composition</button><button className="takes-toggle" onClick={() => { setLibraryTab('takes'); setLibraryOpen(true); }}><ListMusic size={16} /> Takes <span>{takes.length.toString().padStart(2, '0')}</span></button></div></div>

      <Player take={selectedTake} onError={setError} />
      <ResourceStrip request={request} job={currentJob} />

      {(error || connectionError || notice) && <div className={`notice-bar ${error || connectionError ? 'notice-error' : ''}`} role={error || connectionError ? 'alert' : 'status'}><span>{error || connectionError || notice}</span><div>{previousDraft && !error && !connectionError && <button onClick={() => { setRequest(previousDraft); setScoreOpen(Boolean(previousDraft.abc)); setPreviousDraft(null); setNotice('Previous draft restored.'); }}>Restore previous draft</button>}<button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}><X size={14} /></button></div></div>}

      <RadioPanel draft={request} onError={setError} onTakesChanged={refreshLibrary} onActiveChange={setRadioActive} blocked={Boolean((active && !radioBusy) || writing)} />
      <IdeaWriter musicBusy={Boolean(active || submitting || radioBusy)} waitingForWriter={writing} onBusyChange={handleWriterBusy} onApply={(song, durationSeconds) => {
        setPreviousDraft(request);
        const maximum = Math.min(9000, durationSeconds * 25);
        update({ title: song.title, lyrics: song.lyrics, style: song.style, semantic_max_tokens: maximum, semantic_min_tokens: Math.min(request.semantic_min_tokens, maximum) });
        setError(''); setNotice('Writer draft applied. Your previous composition can be restored.');
      }} />

      <div className="writing-surface">
        <section className="lyrics-panel">
          <div className="panel-heading"><div><span className="section-index">01</span><h2>The words</h2></div><span className="panel-meta">LYRICS & STRUCTURE</span></div>
          <div className="lyrics-editor"><textarea aria-label="Song lyrics" value={request.lyrics} onChange={e => update({ lyrics: e.target.value })} placeholder={'[Verse]\nStart with a line you want to hear.\nA place, a feeling, a small detail.\n\n[Chorus]\nGive it something to return to.'} spellCheck={true} /><div className="editor-margin" aria-hidden="true"><span>VERSE</span><span>CHORUS</span><span>BRIDGE</span></div></div>
          <div className="editor-footer"><div className="section-shortcuts">{['Verse', 'Chorus', 'Bridge', 'Outro'].map(section => <button key={section} onClick={() => update({ lyrics: `${request.lyrics}${request.lyrics.trim() ? '\n\n' : ''}[${section}]\n` })}>+ {section}</button>)}</div><span>{words} words <b>·</b> {sections} sections</span></div>
        </section>
        <section className="direction-panel">
          <div className="panel-heading"><div><span className="section-index">02</span><h2>The sound</h2></div><span className="panel-meta">MUSICAL DIRECTION</span></div>
          <textarea className="style-editor" spellCheck={true} aria-label="Musical style and direction" value={request.style} onChange={e => update({ style: e.target.value })} placeholder="Describe the music you have in mind. Genre, instruments, voice, atmosphere, movement…" />
          <div className="starting-points"><span>START SOMEWHERE</span><div>{startingPoints.map(preset => <button key={preset.name} onClick={() => update({ style: preset.style, ...(!request.lyrics.trim() ? { lyrics: preset.lyrics } : {}), ...(!request.title.trim() ? { title: preset.title } : {}) })}>{preset.name}<ArrowRight size={11} /></button>)}</div></div>
          <div className="planning-section"><div className="field-label">COMPOSITION ROUTE<span>How the song takes shape</span></div><div className="mode-selector" role="group" aria-label="Composition route">{modes.map((item, i) => <button key={item.value} aria-pressed={request.cot === item.value} className={request.cot === item.value ? 'selected' : ''} onClick={() => chooseMode(item.value)}><span className="mode-glyph" aria-hidden="true">{i === 0 ? '—' : i === 1 ? '∿' : '≋'}</span>{item.label}</button>)}</div><p className="mode-description">{mode.description}</p></div>
        </section>
      </div>

      <section className="score-section"><button className="disclosure-button" aria-expanded={scoreOpen} onClick={() => setScoreOpen(!scoreOpen)}><FileMusic size={16} /><span>Bring your own melody</span><small>Optional ABC score</small>{request.abc.trim() && <i className="supplied-badge">SCORE SUPPLIED</i>}{scoreOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</button>{scoreOpen && <ScoreInput value={request.abc} onChange={abc => update({ abc })} disabled={request.cot === 'off'} />}</section>

      <div className="compose-footer"><div className="footer-controls"><button className={`fine-control ${advanced ? 'selected' : ''}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Settings2 size={16} /> Fine control {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>{!active && <button className="preview-button" title="Generate a separate take of up to 30 seconds. Your full composition stays unchanged." disabled={!loaded || !status?.ready || Boolean(connectionError) || submitting || writing || radioBusy || !request.lyrics.trim() || !request.style.trim()} onClick={() => void generate(true)}><Headphones size={14} />Preview 30s</button>}<span className="generation-summary">{request.num_inference_steps} steps <b>·</b> {request.seed ? `seed ${request.seed}` : 'new seed each take'}</span></div><div className="generate-area"><label className="memory-wait-toggle" title="Save this take and start automatically when enough memory is available"><input type="checkbox" checked={request.wait_for_memory} disabled={Boolean(active) || submitting} onChange={event => update({ wait_for_memory: event.target.checked })} /><span>Wait for memory</span></label><span>{waiting ? 'This take will start when memory becomes available.' : active ? 'Your draft stays editable while the engine works.' : writing ? 'Finish writing before composing audio.' : 'Every take is saved. Follow your curiosity.'}</span>{radioBusy ? <button className="compose-button" disabled>Radio reserves the engine</button> : active ? <button className="cancel-button" disabled={submitting} onClick={() => void cancel()}><Square size={14} fill="currentColor" /> {waiting ? 'Cancel waiting' : 'Stop generation'}</button> : <button className="compose-button" disabled={!loaded || !status?.ready || Boolean(connectionError) || submitting || writing || radioBusy || !request.lyrics.trim() || !request.style.trim()} onClick={() => void generate()}>{submitting ? <LoaderCircle size={17} className="spin" /> : <span className="compose-symbol" aria-hidden="true">✳</span>} Compose a take <span className="shortcut">CTRL ↵</span></button>}</div></div>

      {currentJob && !currentJob.radio && <GenerationProgress key={currentJob.id} job={currentJob} busy={Boolean(active || writing || radioBusy || submitting || !status?.ready)} onRestore={attempt => void restoreAttempt(attempt)} onRetry={attempt => void retryAttempt(attempt)} onHistory={openHistory} onError={setError} />}
      {advanced && <Advanced request={request} update={update} />}

      <div className="generation-history-link"><button className="text-button" onClick={openHistory}>Generation history <span>{history.length}</span><ArrowRight size={13} /></button></div>
      <div className="bottom-caption"><span>YUÈ STUDIO <b>©</b> A space to make something yours.</span><span>LOCAL ENGINE <i /> NO GENERATION CREDITS</span></div>
    </main>

    {libraryOpen && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setLibraryOpen(false); }}><section className="takes-dialog" role="dialog" aria-modal="true" aria-labelledby="takes-title"><div className="dialog-heading"><div><div className="eyebrow">THE TAKE REGISTER</div><h2 id="takes-title">Every interpretation.</h2></div><button className="icon-button" aria-label="Close take register" onClick={() => setLibraryOpen(false)}><X size={20} /></button></div><div className="register-tabs" role="group" aria-label="Register view"><button className={libraryTab === 'takes' ? 'selected' : ''} aria-pressed={libraryTab === 'takes'} onClick={() => setLibraryTab('takes')}>Finished takes <span>{takes.length}</span></button><button className={libraryTab === 'history' ? 'selected' : ''} aria-pressed={libraryTab === 'history'} onClick={() => setLibraryTab('history')}>Generation history <span>{history.length}</span></button><button className={libraryTab === 'trash' ? 'selected' : ''} aria-pressed={libraryTab === 'trash'} onClick={()=>setLibraryTab('trash')}>Trash</button></div>{libraryError && <p className="history-error library-notice" role="alert">{libraryError}</p>}{deletedItem && <div className="library-notice" role="status"><span>{deletedItem.title} moved to Trash.</span><button disabled={deleteBusy} onClick={()=>void undoDelete()}>Undo deletion</button></div>}{libraryTab === 'trash' ? <TrashPanel revision={trashRevision} onChanged={()=>{setDeletedItem(null);setLibraryError("");refreshLibrary();}} onError={setLibraryError} /> : libraryTab === 'history' ? <GenerationHistory jobs={history} loading={historyLoading} error={historyError} busy={Boolean(active || writing || radioBusy || submitting || !status?.ready)} onRefresh={() => void loadHistory().catch(() => undefined)} onRestore={attempt => void restoreAttempt(attempt)} onRetry={attempt => void retryAttempt(attempt)} onDelete={attempt=>void deleteItem('jobs',attempt.id)} deleteBusy={deleteBusy} onListen={takeId => { setSelectedId(takeId); setLibraryOpen(false); }} onError={setError} /> : <><div className="takes-toolbar"><label><Search size={16} /><input aria-label="Search takes" placeholder="Find a composition…" value={search} onChange={e => setSearch(e.target.value)} /></label><button className={`favorite-filter ${favoritesOnly ? 'selected' : ''}`} aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}><Star size={14} fill={favoritesOnly ? 'currentColor' : 'none'} /> Favorites</button></div><div className="take-list">{filteredTakes.length ? filteredTakes.map((take, index) => <div className={`take-row ${selectedId === take.id ? 'selected' : ''}`} key={take.id}><button className="take-select" onClick={() => { setSelectedId(take.id); setLibraryOpen(false); }}><span className="take-number">{String(takes.length - takes.indexOf(take)).padStart(2, '0')}</span><div><strong>{take.title}</strong><span>{new Date(take.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} <b>·</b> {modes.find(item => item.value === take.request.cot)?.label || 'Direct'}</span><p>{take.request.style}</p></div><span className="take-duration">{timeLabel(take.duration)}{selectedId === take.id ? <Headphones size={14} /> : null}</span></button><div className="take-actions"><button className="delete-take" disabled={deleteBusy} title="Move track to Trash" aria-label={`Delete ${take.title}`} onClick={()=>void deleteItem('takes',take.id)}><Trash2 size={15}/></button><SeedButton seed={take.request.seed} onError={setError} /><button aria-label={`${take.favorite ? 'Unfavorite' : 'Favorite'} ${take.title}`} onClick={() => void favorite(take)}><Star size={15} fill={take.favorite ? 'currentColor' : 'none'} /></button><button title="Load these settings as a variation" aria-label={`Use settings from ${take.title}`} onClick={() => useTake(take)}><Copy size={15} /></button><a title="Download WAV" aria-label={`Download ${take.title}`} href={take.audioUrl || `/api/takes/${take.id}/audio`} download={`${take.title}.wav`}><ArrowDownToLine size={15} /></a>{take.hasScore && <a title="Download supplied ABC score" aria-label={`Download supplied score for ${take.title}`} href={`/api/takes/${take.id}/score`} download={`${take.title}.abc`}><FileMusic size={15} /></a>}<a className="request-export" href={`/api/takes/${take.id}/request`} download={`${take.title}.json`} title="Download generation settings">JSON</a></div></div>) : <div className="empty-register"><ListMusic size={32} strokeWidth={1} /><h3>{takes.length ? 'No matching takes.' : 'The first take is still unwritten.'}</h3><p>{takes.length ? 'Try another title or turn off the favorites filter.' : 'Compose a song and it will be kept here, together with every setting that made it.'}</p></div>}</div><div className="register-footer"><span>{takes.length} {takes.length === 1 ? 'take' : 'takes'} saved on this computer</span><button className="text-button" onClick={() => { void loadTakes().catch(err => setError(errorText(err))); }}>Refresh register</button></div></>}</section></div>}

    {engineOpen && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setEngineOpen(false); }}><section className="info-dialog" role="dialog" aria-modal="true" aria-labelledby="engine-title"><div className="dialog-heading"><div><div className="eyebrow">UNDER THE SURFACE</div><h2 id="engine-title">Your local engine.</h2></div><button className="icon-button" aria-label="Close engine details" onClick={() => setEngineOpen(false)}><X size={20} /></button></div><div className="engine-readiness"><span className={`status-dot ${status?.ready ? 'ready' : ''}`} /><strong>{status?.ready ? 'Ready to compose' : 'Engine setup in progress'}</strong></div>{(status?.runtime.reason || connectionError) && <p className="engine-reason">{status?.runtime.reason || connectionError}</p>}<dl className="engine-details"><dt>Model</dt><dd>{status?.runtime.model || 'YuE2 · awaiting engine'}</dd><dt>Runtime</dt><dd>{status?.runtime.name || 'audio.cpp'} {status?.runtime.version || ''}</dd><dt>Backend</dt><dd>{status?.runtime.backend || request.backend}</dd><dt>Graphics</dt><dd>{status?.hardware.gpu || 'Checking hardware…'}</dd><dt>Processor</dt><dd>{status?.hardware.cpu || 'Checking hardware…'}</dd><dt>System memory</dt><dd>{status?.hardware.ramGB ? `${status.hardware.ramGB} GB` : '—'}</dd></dl><p className="info-footnote">Generation runs on this computer. The YuE2 weights are licensed for noncommercial use. No account or generation credits are needed.</p></section></div>}

    {helpOpen && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setHelpOpen(false); }}><section className="info-dialog guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title"><div className="dialog-heading"><div><div className="eyebrow">A FEW NOTES</div><h2 id="guide-title">From a thought to a song.</h2></div><button className="icon-button" aria-label="Close studio guide" onClick={() => setHelpOpen(false)}><X size={20} /></button></div><ol className="guide-steps"><li><span>01</span><div><h3>Give it words.</h3><p>Use section labels such as [Verse] and [Chorus]. Short, singable lines help the model find a natural performance.</p></div></li><li><span>02</span><div><h3>Describe a sound.</h3><p>Name the voice, instruments, atmosphere and movement. A starting point can fill a draft you can make your own.</p></div></li><li><span>03</span><div><h3>Choose a route.</h3><p>Direct goes straight to audio. Melody and Melody + chords plan internally first. You can supply your own ABC notation in either planning mode.</p></div></li><li><span>04</span><div><h3>Keep listening.</h3><p>Finished takes keep their settings. Generation history also preserves failed and stopped attempts, so you can restore a draft or retry with its original seed.</p></div></li></ol><p className="info-footnote">Wait for memory saves a take until enough GPU, RAM and Windows commit headroom is available; you can cancel waiting at any time. Duration is an upper limit, and audio may finish earlier. Score preview shows only notation you supply.</p></section></div>}
  </div>;
}






