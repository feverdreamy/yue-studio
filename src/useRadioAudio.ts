import { useCallback, useEffect, useRef, useState } from 'react';
import type { RadioTrack } from './radioTypes';
interface Props { queue: RadioTrack[]; onConsume: (takeId: string | null) => Promise<void>; onError: (message: string) => void; }
interface Fade { old: HTMLAudioElement; next: HTMLAudioElement; startedAt: number; seconds: number; timer: number; }

/** Two actual media decks; a serialized queue acknowledgement owns each handover. */
export default function useRadioAudio({ queue, onConsume, onError }: Props) {
  const decks = useRef<[HTMLAudioElement | null, HTMLAudioElement | null]>([null, null]);
  const prepared = useRef<[string | null, string | null]>([null, null]);
  const activeDeck = useRef(0), currentRef = useRef<RadioTrack | null>(null);
  const queueRef = useRef(queue); queueRef.current = queue;
  const handlers = useRef({ onConsume, onError }); handlers.current = { onConsume, onError };
  const consumed = useRef(new Set<string>()), wantsPlayback = useRef(false), epoch = useRef(0);
  const deleted = useRef(new Set<string>());
  const pending = useRef(false), fadeRef = useRef<Fade | null>(null), alive = useRef(true), volumeRef = useRef(.75);
  const [current, setCurrent] = useState<RadioTrack | null>(null);
  const [playing, setPlaying] = useState(false), [armed, setArmed] = useState(false);
  const [position, setPosition] = useState(0), [duration, setDuration] = useState(0), [volume, setVolume] = useState(.75);
  const [transitioning, setTransitioning] = useState(false), [handover, setHandover] = useState(0);
  const nextTrack = () => queueRef.current.find(track => track.takeId !== currentRef.current?.takeId && !consumed.current.has(track.takeId));
  function prepare(index: number, track: RadioTrack) {
    const deck = decks.current[index];
    if (!deck || prepared.current[index] === track.takeId) return deck;
    deck.pause(); deck.src = track.audioUrl || `/api/takes/${track.takeId}/audio`; deck.preload = 'auto'; prepared.current[index] = track.takeId; deck.load();
    return deck;
  }
  function finishFade() {
    const fade = fadeRef.current; if (!fade) return;
    window.clearInterval(fade.timer); fade.old.pause(); fade.old.volume = 0; fade.next.volume = volumeRef.current; fadeRef.current = null;
    setTransitioning(pending.current); setHandover(value => value + 1);
  }
  function advanceFade() {
    const fade = fadeRef.current; if (!fade) return;
    // The media clock continues when a background window is not being painted.
    const ratio = Math.min(1, Math.max(0, (fade.next.currentTime - fade.startedAt) / fade.seconds));
    if (ratio >= 1 || fade.old.ended) { finishFade(); return; }
    fade.old.volume = Math.cos(ratio * Math.PI / 2) * volumeRef.current;
    fade.next.volume = Math.sin(ratio * Math.PI / 2) * volumeRef.current;
  }
  const pause = useCallback(() => {
    wantsPlayback.current = false; setArmed(false); ++epoch.current;
    const fade = fadeRef.current; if (fade) { window.clearInterval(fade.timer); fadeRef.current = null; }
    for (const deck of decks.current) deck?.pause();
    const active = decks.current[activeDeck.current]; if (active) active.volume = volumeRef.current;
    // Keep pending true until media/HTTP settles: rapid resume cannot reuse that deck.
    setTransitioning(pending.current); setPlaying(false);
  }, []);
  async function begin(track: RadioTrack, fade = false) {
    if (pending.current || fadeRef.current || !wantsPlayback.current) return;
    pending.current = true; setTransitioning(true);
    const token = epoch.current, oldIndex = activeDeck.current;
    const old = currentRef.current ? decks.current[oldIndex] : null;
    const index = currentRef.current ? 1 - oldIndex : oldIndex, deck = prepare(index, track);
    let interrupted = false;
    if (!deck) { pending.current = false; setTransitioning(false); return; }
    deck.currentTime = 0; deck.volume = 0;
    try {
      window.dispatchEvent(new CustomEvent('yue-radio-playing'));
      await deck.play();
      if (token !== epoch.current || !alive.current) { deck.pause(); interrupted = true; return; }
      // Prime permission/loading, but do not use up the song while the server acknowledges it.
      deck.pause(); deck.currentTime = 0;
      await handlers.current.onConsume(track.takeId);
      if (!alive.current) { deck.pause(); return; }
      if (deleted.current.has(track.takeId)) { deck.pause(); return; }
      // A committed take remains selected if Stop arrived during its acknowledgement.
      consumed.current.add(track.takeId); activeDeck.current = index; currentRef.current = track; setCurrent(track);
      setDuration(Number.isFinite(deck.duration) ? deck.duration : track.duration); setPosition(deck.currentTime);
      if (token !== epoch.current || !wantsPlayback.current) { deck.pause(); interrupted = true; setPlaying(false); return; }
      deck.volume = fade && old && !old.paused ? 0 : volumeRef.current;
      await deck.play();
      if (token !== epoch.current || !alive.current) { deck.pause(); interrupted = true; setPlaying(false); return; }
      setPlaying(true);
      if (fade && old && !old.paused && old !== deck) {
        const seconds = Math.max(.15, Math.min(1.2, old.duration - old.currentTime));
        fadeRef.current = { old, next: deck, startedAt: deck.currentTime, seconds, timer: window.setInterval(advanceFade, 25) };
        advanceFade();
      } else { if (old && old !== deck) old.pause(); deck.volume = volumeRef.current; }
    } catch (error) {
      deck.pause();
      if (token !== epoch.current) interrupted = true;
      else { pause(); handlers.current.onError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Press Play to allow radio playback in this browser.' : 'Radio playback could not start. Playback is paused; check the station and press Play to try again.'); }
    } finally {
      pending.current = false; setTransitioning(Boolean(fadeRef.current)); setHandover(value => value + 1);
      if (interrupted && wantsPlayback.current && alive.current) void resume();
    }
  }
  async function resume() {
    wantsPlayback.current = true; setArmed(true);
    if (pending.current || fadeRef.current) return;
    const deck = decks.current[activeDeck.current];
    if (currentRef.current && deck && !deck.ended && deck.currentTime < (Number.isFinite(deck.duration) ? deck.duration : Infinity)) {
      pending.current = true; const token = epoch.current; let interrupted = false;
      try { deck.volume = volumeRef.current; window.dispatchEvent(new CustomEvent('yue-radio-playing')); await deck.play(); if (token !== epoch.current || !alive.current) { deck.pause(); interrupted = true; return; } setPlaying(true); }
      catch { if (token !== epoch.current) interrupted = true; else { pause(); handlers.current.onError('The browser paused radio playback. Press Play to listen to the ready take.'); } }
      finally { pending.current = false; setTransitioning(false); if (interrupted && wantsPlayback.current && alive.current) void resume(); }
    } else { const next = nextTrack(); if (next) await begin(next); }
  }
  async function clearCurrent() {
    if (pending.current) return; pending.current = true;
    currentRef.current = null; setCurrent(null); setPlaying(false); setPosition(0); setDuration(0);
    try { await handlers.current.onConsume(null); }
    catch { pause(); handlers.current.onError('Could not update the radio queue. Playback is paused; refresh the station before continuing.'); }
    finally { pending.current = false; setTransitioning(false); setHandover(value => value + 1); }
  }
  async function skip() {
    if (pending.current || fadeRef.current) return;
    decks.current[activeDeck.current]?.pause(); wantsPlayback.current = true; setArmed(true);
    const next = nextTrack(); if (next) await begin(next); else await clearCurrent();
  }
  function onTimeUpdate(index: number) {
    advanceFade(); if (index !== activeDeck.current) return;
    const deck = decks.current[index]; if (!deck) return;
    setPosition(deck.currentTime); if (Number.isFinite(deck.duration)) setDuration(deck.duration);
    if (!wantsPlayback.current || deck.paused || pending.current || fadeRef.current || !Number.isFinite(deck.duration)) return;
    const next = nextTrack(), preloaded = decks.current[1 - index];
    if (next && prepared.current[1 - index] === next.takeId && preloaded && preloaded.readyState >= 2 && deck.duration - deck.currentTime <= 1.2) void begin(next, true);
  }
  function onEnded(index: number) {
    advanceFade(); if (index !== activeDeck.current || pending.current || fadeRef.current) return;
    setPlaying(false); if (!wantsPlayback.current) return;
    const next = nextTrack(); if (next) void begin(next); else void clearCurrent();
  }
  function audioError(index: number) { if (index === activeDeck.current && currentRef.current) { pause(); handlers.current.onError('This radio take could not be loaded. It remains in the take register.'); } }
  useEffect(() => { volumeRef.current = volume; if (fadeRef.current) advanceFade(); else { const active = decks.current[activeDeck.current]; if (active) active.volume = volume; } }, [volume]);
  useEffect(() => {
    if (pending.current || fadeRef.current) return;
    const next = nextTrack(); if (next) prepare(currentRef.current ? 1 - activeDeck.current : activeDeck.current, next);
    if (!currentRef.current && wantsPlayback.current && next) void begin(next);
  }, [queue, current?.takeId, handover]);
  useEffect(() => {
    alive.current = true; const stopForManual = () => pause(); window.addEventListener('yue-manual-playing', stopForManual);
    const removeDeletedTake = (event: Event) => {
      const id = (event as CustomEvent<{ id: string }>).detail?.id; if (!id) return;
      deleted.current.add(id); consumed.current.add(id);
      if (currentRef.current?.takeId === id) { pause(); currentRef.current = null; setCurrent(null); setPosition(0); setDuration(0); }
      prepared.current.forEach((takeId, index) => { if (takeId === id) { decks.current[index]?.pause(); prepared.current[index] = null; } });
      setHandover(value => value + 1);
    };
    window.addEventListener('yue-take-deleted', removeDeletedTake);
    return () => { alive.current = false; window.removeEventListener('yue-manual-playing', stopForManual); window.removeEventListener('yue-take-deleted', removeDeletedTake); ++epoch.current; wantsPlayback.current = false; if (fadeRef.current) window.clearInterval(fadeRef.current.timer); for (const deck of decks.current) deck?.pause(); };
  }, [pause]);
  return { decks, current, playing, armed, position, duration, volume, setVolume, transitioning, resume, pause, skip, onTimeUpdate, onEnded, audioError };
}

