import type { GenerationRequest } from './types';

export type RadioProvider = 'ollama' | 'deepinfra' | 'openai';
export interface RadioConfig {
  provider: RadioProvider;
  model: string;
  idea: string;
  style: string;
  seed: string;
  durationSeconds: number;
  bufferAhead: number;
  maxTracksPerSession: number;
  generation: GenerationRequest;
}
export interface RadioTrack { takeId: string; title: string; duration: number; audioUrl?: string; seed?: string; }
export interface RadioMemory { key: string; value: string; updatedAt: string; }
export interface RadioMessage { id: string; role: 'user' | 'host'; text: string; at: string; status?: string; }
export interface RadioState {
  version: number;
  status: 'off' | 'running' | 'paused';
  stage: string;
  activity: 'idle' | 'host' | 'writing' | 'rendering' | 'waiting' | 'buffered' | 'error';
  error?: string | null;
  config: RadioConfig;
  memories: RadioMemory[];
  messages: RadioMessage[];
  queue: RadioTrack[];
  currentTakeId: string | null;
  activeJobId: string | null;
  activeJob?: { id: string; status: string; stage: string; error?: string } | null;
  session: { id: string; createdTracks: number; startedAt: string } | null;
  pendingMessages: number;
}
export interface RadioModel { id: string; name?: string; label?: string; sizeBytes?: number; }
export interface RadioWriterSettings { recommendedLocalModel?: string; providers: Record<RadioProvider, { configured: boolean; source?: string }>; secureStorage: boolean; }
