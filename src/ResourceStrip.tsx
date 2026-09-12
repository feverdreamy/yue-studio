import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Clock3, Info, LoaderCircle } from 'lucide-react';
import { api, type GenerationRequest, type Job, type ResourceAssessment, type ResourceSnapshot } from './types';

export function memoryLabel(bytes: number | null | undefined) {
  return typeof bytes === 'number' && Number.isFinite(bytes) ? `${(Math.max(0, bytes) / 1073741824).toFixed(1)} GiB` : 'Unavailable';
}
interface Props { request: GenerationRequest; job: Job | null; }

export default function ResourceStrip({ request, job }: Props) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [assessment, setAssessment] = useState<ResourceAssessment | null>(null);
  const [error, setError] = useState('');
  const query = new URLSearchParams({ semantic_max_tokens: String(request.semantic_max_tokens), cot: request.cot, backend: request.backend, weight_storage: request.weight_storage }).toString();
  useEffect(() => {
    let stopped = false;
    let timer: number;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<{ resources: ResourceSnapshot; assessment: ResourceAssessment }>(`/api/resources?${query}`, { signal: controller.signal });
        if (stopped) return;
        setSnapshot(next.resources); setAssessment(next.assessment); setError('');
      } catch { if (!stopped) { setSnapshot(null); setAssessment(null); setError('Memory readings are temporarily unavailable.'); } }
      if (!stopped) timer = window.setTimeout(poll, 5000);
    };
    timer = window.setTimeout(poll, 200);
    return () => { stopped = true; window.clearTimeout(timer); controller.abort(); };
  }, [query, job?.id, job?.status]);
  const waiting = job?.status === 'waiting';
  const running = job?.status === 'running';
  const state = waiting ? 'waiting' : assessment?.state || 'unknown';
  const label = running ? 'Engine rendering' : waiting ? 'Waiting for memory' : error ? 'Readings unavailable' : !snapshot ? 'Checking memory' : state === 'ready' ? 'Headroom available' : state === 'waiting' ? 'Memory is in use' : 'Some readings unavailable';
  const requirements = assessment?.requirements;
  return <section className={`resource-strip resource-${state}`} aria-label="Computer memory status">
    <div className="resource-line"><button className="resource-disclosure" onClick={() => setOpen(!open)} aria-expanded={open}><span className="resource-status-icon">{waiting ? <Clock3 size={15} /> : !snapshot && !error ? <LoaderCircle size={15} className="spin" /> : <Info size={15} />}</span><span>{label}</span>{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button><div className="resource-readings"><span><b>GPU</b><strong>{memoryLabel(snapshot?.gpu?.availableBytes)}</strong>{snapshot?.gpu?.availableBytes != null && ' free'}</span><span><b>RAM</b><strong>{memoryLabel(snapshot?.ram?.availableBytes)}</strong>{snapshot?.ram?.availableBytes != null && ' free'}</span><span className="resource-commit"><b>COMMIT</b><strong>{memoryLabel(snapshot?.commit?.availableBytes)}</strong>{snapshot?.commit?.availableBytes != null && ' free'}</span></div></div>
    {open && <div className="resource-details"><p>{running ? 'Available memory includes the current render. The next take is checked again before it starts.' : waiting ? job.waitingReason || 'This take will begin automatically when enough memory is available. Your saved lyrics and seed stay the same.' : error || (assessment?.reasons?.length ? assessment.reasons.join(' ') : 'The engine checks free GPU, system and commit memory before starting each take.')}</p>{requirements && <dl><div><dt>Estimated GPU need</dt><dd>{request.backend === 'cpu' ? 'CPU selected' : memoryLabel(requirements.gpuBytes)}</dd></div><div><dt>Estimated RAM need</dt><dd>{memoryLabel(requirements.ramBytes)}</dd></div><div><dt>Estimated commit need</dt><dd>{memoryLabel(requirements.commitBytes)}</dd></div></dl>}<p className="resource-footnote">Commit is memory Windows can back with RAM and its paging file. These checks estimate headroom; other apps can change their memory use during a render.</p><div className="resource-detail-footer"><span>{snapshot?.gpu?.name || 'Graphics reading unavailable'}</span><span>{snapshot?.sampledAt ? `Checked ${new Date(snapshot.sampledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'No current sample'}</span></div></div>}
  </section>;
}
