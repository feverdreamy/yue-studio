import { useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, ChevronUp, Clock3, History, LoaderCircle, RotateCcw, Search, Square, Trash2 } from 'lucide-react';
import SeedButton from './SeedButton';
import { type Job, timeLabel } from './types';

export type HistoryEntry = Job;
interface Props {
  onDelete: (job:HistoryEntry)=>void;
  deleteBusy:boolean;
  jobs: HistoryEntry[];
  loading: boolean;
  error: string;
  busy: boolean;
  onRefresh: () => void;
  onRestore: (job: HistoryEntry) => void;
  onRetry: (job: HistoryEntry) => void;
  onListen: (takeId: string) => void;
  onError: (message: string) => void;
}

const stateLabels = { waiting: 'Waiting for memory', running: 'Rendering', completed: 'Saved take', failed: 'Needs attention', cancelled: 'Stopped' };
function downloadSettings(job: Job, title: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(job.request, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${title}.json`; document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function GenerationHistory({ onDelete, deleteBusy, jobs, loading, error, busy, onRefresh, onRestore, onRetry, onListen, onError }: Props) {
  const [search, setSearch] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const filtered = jobs.filter(job => (!attentionOnly || job.status === 'failed' || job.status === 'cancelled') && `${job.title || job.request?.title || ''} ${job.seed ?? job.request?.seed ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="generation-history" aria-label="Generation history">
    <div className="history-intro"><p>Every attempt keeps its place.<span>Recover the original words, settings and seed, even when a take could not finish.</span></p><button className="text-button" disabled={loading} onClick={onRefresh}>{loading ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}Refresh</button></div>
    <div className="takes-toolbar history-toolbar"><label><Search size={16} /><input aria-label="Search generation history" placeholder="Find a title or seed…" value={search} onChange={event => setSearch(event.target.value)} /></label><button className={`favorite-filter ${attentionOnly ? 'selected' : ''}`} aria-pressed={attentionOnly} onClick={() => setAttentionOnly(!attentionOnly)}>Needs attention</button></div>
    {error && <p className="history-error" role="alert">{error}</p>}
    <div className="history-list">
      {filtered.map(job => {
        const title = job.title || job.request?.title || 'Untitled composition';
        const seed = job.seed ?? job.request?.seed;
        const pending = job.status === 'waiting' || job.status === 'running';
        const open = expanded === job.id;
        return <article className={`history-entry history-entry-${job.status}`} key={job.id}>
          <div className="history-entry-heading"><span className={`history-state-mark history-state-${job.status}`} aria-hidden="true">{job.status === 'completed' ? <Check size={16} /> : job.status === 'waiting' ? <Clock3 size={16} /> : job.status === 'running' ? <LoaderCircle size={16} className="spin" /> : <Square size={13} />}</span><div><h3>{title}</h3><p><span>{stateLabels[job.status]}</span><b>·</b>{new Date(job.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}<b>·</b>{timeLabel(job.elapsedSeconds)} elapsed</p></div><SeedButton seed={seed} onError={onError} /></div>
          {job.error && <p className="history-failure">{job.error}</p>}
          {pending && <p className="history-pending">{job.stage || stateLabels[job.status]}</p>}
          <div className="history-entry-actions">{!pending&&<button className="history-delete" disabled={deleteBusy} aria-label={`Delete attempt ${title}`} title="Move attempt to Trash" onClick={()=>onDelete(job)}><Trash2 size={14}/></button>}<button className="text-button" aria-expanded={open} aria-label={`${open ? 'Close' : 'View'} details for ${title}`} onClick={() => setExpanded(open ? null : job.id)}>Details {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button><div>{job.takeId && <button className="history-secondary" onClick={() => onListen(job.takeId!)}>Listen to take</button>}<button className="history-secondary" disabled={busy} aria-label={`Restore settings for ${title}`} onClick={() => onRestore(job)}>Restore settings</button>{!pending && <button className="history-retry" disabled={busy} aria-label={`Retry ${title} with the same seed`} onClick={() => onRetry(job)}><RotateCcw size={13} />Retry same take</button>}</div></div>
          {open && <div className="history-details">{job.request && <dl><dt>Composition route</dt><dd>{job.request.cot === 'off' ? 'Direct' : job.request.cot === 'melody' ? 'Melody' : 'Melody + chords'}</dd><dt>Duration ceiling</dt><dd>{Math.round(job.request.semantic_max_tokens / 25)} seconds</dd><dt>Rendering</dt><dd>{job.request.num_inference_steps} steps · {job.request.weight_storage === 'q8_0' ? 'Efficient Q8' : 'Original storage'}</dd></dl>}<div className="history-log-heading"><span>ENGINE LOG</span><div>{job.request && <button onClick={() => downloadSettings(job, title)}><ArrowDownToLine size={13} />Saved settings</button>}<a href={`/api/jobs/${job.id}/log`} download><ArrowDownToLine size={13} />Engine log</a></div></div><pre className="job-log">{job.log?.length ? job.log.join('\n') : pending ? 'The engine has not reported any details yet.' : 'No engine log was recorded for this attempt.'}</pre></div>}
        </article>;
      })}
      {!filtered.length && <div className="empty-register history-empty">{loading ? <LoaderCircle className="spin" size={28} strokeWidth={1} /> : <History size={30} strokeWidth={1} />}<h3>{loading ? 'Opening the session history.' : jobs.length ? 'No matching attempts.' : 'A clean page.'}</h3><p>{loading ? 'Reading the attempts saved on this computer.' : jobs.length ? 'Try another title or change the attention filter.' : 'Your next generation will appear here, together with the settings that made it.'}</p></div>}
    </div>
    <div className="register-footer"><span>{jobs.length} {jobs.length === 1 ? 'attempt' : 'attempts'} saved on this computer</span><span>Retry keeps the same seed and settings.</span></div>
  </section>;
}

