import { useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, Clock3, History, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import SeedButton from './SeedButton';
import { type Job, timeLabel } from './types';

interface Props { job: Job; busy: boolean; onRestore: (job: Job) => void; onRetry: (job: Job) => void; onHistory: () => void; onError: (message: string) => void; }
export default function GenerationProgress({ job, busy, onRestore, onRetry, onHistory, onError }: Props) {
  const [logOpen, setLogOpen] = useState(false);
  const waiting = job.status === 'waiting';
  const running = job.status === 'running';
  const recoverable = job.status === 'failed' || job.status === 'cancelled';
  const label = waiting ? 'Waiting for memory' : running ? job.stage || 'Composing your take' : job.status === 'completed' ? 'Take complete' : job.status === 'cancelled' ? 'Generation stopped' : 'Generation needs attention';
  return <section className={`job-panel job-${job.status}`} aria-label="Current generation">
    <div className="job-topline"><div className="job-state">{waiting ? <Clock3 size={16} /> : running ? <LoaderCircle size={16} className="spin" /> : job.status === 'completed' ? <Check size={16} /> : <Square size={13} />}<strong>{label}</strong><span>{timeLabel(waiting ? job.waitSeconds || 0 : job.elapsedSeconds)} {waiting ? 'waiting' : 'elapsed'}</span></div><button className="text-button" onClick={() => setLogOpen(!logOpen)}>{logOpen ? 'Close log' : 'Generation log'}<ChevronDown size={13} /></button></div>
    {waiting && <div className="waiting-copy">{job.title && <strong>{job.title}</strong>}<p>{job.waitingReason || 'The take is saved and will begin when enough memory is available.'}</p><span>You can keep editing this draft. The queued take keeps its saved words, settings and seed. Cancel waiting to change that take.</span></div>}
    {job.error && <p className="generation-error">{job.error}</p>}
    {running && <div className="job-motion" aria-hidden="true" />}
    {(waiting || recoverable) && <div className="generation-recovery"><div><SeedButton seed={job.seed ?? job.request?.seed} onError={onError} /><button className="text-button" onClick={onHistory}><History size={14} />History</button></div>{recoverable && <div><button className="history-secondary" disabled={busy} onClick={() => onRestore(job)}>Restore settings</button><button className="history-retry" disabled={busy} onClick={() => onRetry(job)}><RotateCcw size={13} />Retry same take</button></div>}</div>}
    {logOpen && <div className="generation-log-content"><pre className="job-log">{job.log?.length ? job.log.join('\n') : waiting ? 'The engine has not started. This take is waiting for memory.' : running ? 'Stage details appear when reported by the runtime.' : 'No engine log was recorded for this attempt.'}</pre><a href={`/api/jobs/${job.id}/log`} download><ArrowDownToLine size={13} />Download engine log</a></div>}
  </section>;
}
