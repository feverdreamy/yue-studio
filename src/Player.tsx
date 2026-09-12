import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Pause, Play, Repeat2, SkipBack, Volume2 } from 'lucide-react';
import { type Take, timeLabel } from './types';
import SeedButton from './SeedButton';

interface Props { take: Take | null; onError: (message: string) => void; }

export default function Player({ take, onError }: Props) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(.8);
  const [loop, setLoop] = useState(false);
  const [speed, setSpeed] = useState(1);
  const length = duration || take?.duration || 0;

  useEffect(() => { setPosition(0); setDuration(0); setPlaying(false); }, [take?.id]);
  useEffect(()=>{const pause=()=>audio.current?.pause();window.addEventListener('yue-radio-playing',pause);return()=>window.removeEventListener('yue-radio-playing',pause);},[]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume, take]);
  useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed, take]);

  const peaks = useMemo(() => {
    if (!take?.peaks.length) return [];
    const count = Math.min(210, take.peaks.length);
    return Array.from({ length: count }, (_, i) => {
      const start = Math.floor(i * take.peaks.length / count);
      const end = Math.max(start + 1, Math.floor((i + 1) * take.peaks.length / count));
      return Math.max(...take.peaks.slice(start, end).map(n => Math.min(1, Math.abs(n))));
    });
  }, [take]);

  async function toggle() {
    if (!audio.current || !take) return;
    if (!audio.current.paused) audio.current.pause();
    else { try { await audio.current.play(); } catch (error) { onError(error instanceof Error ? error.message : 'Audio playback could not start.'); } }
  }
  function seek(value: number) { if (audio.current) { audio.current.currentTime = value; setPosition(value); } }

  return <section className="listening-deck" aria-label="Audio player">
    <div className="deck-grip" aria-hidden="true"><i /><i /><i /><i /><i /></div>
    <div className="deck-topline">
      <div className="deck-label"><span className={`signal-light ${playing ? 'active' : ''}`} /> LISTENING ROOM <span className="deck-slash">/</span> {take ? 'TAKE SELECTED' : 'NO TAKE LOADED'}</div>
      <span className="deck-format">{take ? `${(take.sampleRate / 1000).toFixed(0)} kHz · ${take.channels === 2 ? 'STEREO' : 'MONO'} · WAV` : '48 kHz · STEREO'}</span>
    </div>
    <div className="deck-body">
      <div className="transport-block">
        <div className="time-readout">{timeLabel(position)}<span> / {timeLabel(length)}</span></div>
        <div className="transport-controls">
          <button className="play-button" onClick={toggle} disabled={!take} aria-label={playing ? 'Pause audio' : 'Play audio'}>{playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
          <button className="deck-icon" disabled={!take} onClick={() => seek(0)} aria-label="Return to start"><SkipBack size={18} /></button>
          <button className={`deck-icon ${loop ? 'is-active' : ''}`} disabled={!take} aria-pressed={loop} onClick={() => setLoop(!loop)} aria-label="Loop audio"><Repeat2 size={19} /></button>
        </div>
      </div>
      <div className="waveform-wrap">
        <div className="waveform-title"><div className="waveform-name" title={take?.title || 'Room for something unheard.'}>{take?.title || 'Room for something unheard.'}</div><span>{take ? new Date(take.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Your compositions will appear here.'}</span></div>
        <div className={`waveform ${!take ? 'empty' : ''}`}>
          <svg viewBox="0 0 840 102" preserveAspectRatio="none" aria-hidden="true">
            <defs><clipPath id="played-wave"><rect x="0" y="0" width={length ? 840 * position / length : 0} height="102" /></clipPath></defs>
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => <line key={i} x1={i * 105} x2={i * 105} y1="4" y2="98" className="wave-grid" />)}
            <line x1="0" x2="840" y1="51" y2="51" className="wave-axis" />
            {peaks.length ? <>
              <g fill="#829083">{peaks.map((peak, i) => <rect key={i} x={i * 840 / peaks.length} y={51 - Math.max(1, peak * 43)} width={Math.max(1, 840 / peaks.length - 1.4)} height={Math.max(2, peak * 86)} rx=".6" />)}</g>
              <g fill="#ec7051" clipPath="url(#played-wave)">{peaks.map((peak, i) => <rect key={i} x={i * 840 / peaks.length} y={51 - Math.max(1, peak * 43)} width={Math.max(1, 840 / peaks.length - 1.4)} height={Math.max(2, peak * 86)} rx=".6" />)}</g>
              <line x1={840 * position / Math.max(1, length)} x2={840 * position / Math.max(1, length)} y1="0" y2="102" stroke="#f1eee5" strokeWidth="1.2" />
            </> : <g className="empty-wave-crosses">{[1, 3, 5, 7].map(i => <path key={i} d={`M${i * 105 - 4} 51h8 M${i * 105} 47v8`} />)}</g>}
          </svg>
          <input type="range" min="0" max={length || 1} step=".05" value={position} onChange={e => seek(Number(e.target.value))} disabled={!take} aria-label="Seek in audio" />
        </div>
        <div className="waveform-ruler">{[0, .25, .5, .75, 1].map((fraction, i) => <span key={i}>{take ? timeLabel(length * fraction) : '—'}</span>)}</div>
      </div>
    </div>
    <div className="deck-bottomline">
      <div className="deck-session-meta"><span className="deck-footnote">{playing ? 'PLAYING' : take ? 'READY TO LISTEN' : 'WRITE. COMPOSE. LISTEN.'}</span>{take && <SeedButton seed={take.request.seed} tone="dark" onError={onError} />}</div>
      <div className="audio-settings">
        <Volume2 size={14} /><input type="range" aria-label="Playback volume" min="0" max="1" step=".01" value={volume} onChange={e => setVolume(Number(e.target.value))} />
        <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value=".75">0.75×</option><option value="1">1× speed</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option></select>
        {take && <a className="deck-download" href={take.audioUrl || `/api/takes/${take.id}/audio`} download={`${take.title || 'yue-take'}.wav`}><ArrowDownToLine size={14} /> WAV</a>}
      </div>
    </div>
    <audio ref={audio} src={take ? take.audioUrl || `/api/takes/${take.id}/audio` : undefined} preload="metadata" loop={loop} onTimeUpdate={e => setPosition(e.currentTarget.currentTime)} onLoadedMetadata={e => setDuration(e.currentTarget.duration)} onPlay={() => {setPlaying(true);window.dispatchEvent(new Event('yue-manual-playing'));}} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { if (take) onError('This take could not be loaded. Check that its audio file is still available.'); }} />
  </section>;
}
