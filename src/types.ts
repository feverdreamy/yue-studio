export type CompositionMode = 'off' | 'melody' | 'full';

export interface GenerationRequest {
  title: string;
  lyrics: string;
  style: string;
  cot: CompositionMode;
  abc: string;
  seed: string;
  num_inference_steps: number;
  cfg_scale: number;
  abc_temperature: number;
  abc_top_p: number;
  abc_top_k: number;
  abc_repetition_penalty: number;
  abc_penalty_window: number;
  abc_min_tokens: number;
  abc_max_tokens: number;
  semantic_temperature: number;
  semantic_top_p: number;
  semantic_top_k: number;
  semantic_repetition_penalty: number;
  semantic_penalty_window: number;
  semantic_min_tokens: number;
  semantic_max_tokens: number;
  backend: 'vulkan' | 'cpu';
  weight_storage: 'q8_0' | 'native';
  wait_for_memory: boolean;
  threads: number;
}

export interface Job {
  radio?: {stationId:string;sessionId:string;sequence:number};
  takeUnavailable?:boolean;
  id: string;
  status: 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled';
  stage: string;
  startedAt: string;
  finishedAt?: string;
  elapsedSeconds: number;
  log: string[];
  error?: string;
  takeId?: string;
  title?: string;
  seed?: string;
  request?: GenerationRequest;
  queuedAt?: string;
  runStartedAt?: string;
  waitSeconds?: number;
  waitingReason?: string;
  resourceCheck?: unknown;
  errorCode?: string;
  retryOf?: string;
}

export interface ResourceSnapshot {
  sampledAt: string | null;
  available: boolean;
  ram: { totalBytes: number | null; availableBytes: number | null } | null;
  commit: { limitBytes: number | null; availableBytes: number | null } | null;
  gpu: { name: string | null; totalBytes: number | null; usedBytes: number | null; availableBytes: number | null; source?: string } | null;
  errors?: string[];
}
export interface ResourceAssessment {
  state: 'ready' | 'waiting' | 'unknown';
  reasons: string[];
  requirements: { ramBytes: number | null; commitBytes: number | null; gpuBytes: number | null };
}

export interface Take {
  radio?: {stationId:string;sessionId:string;sequence:number};
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  sampleRate: number;
  channels: number;
  request: GenerationRequest;
  peaks: number[];
  hasScore: boolean;
  favorite: boolean;
  audioUrl: string;
}

export interface StudioStatus {
  radioActive?:boolean;
  ready: boolean;
  runtime: { name: string; version: string; backend: string; model: string; reason?: string };
  hardware: { gpu: string; cpu: string; ramGB: number };
  activeJob: Job | null;
  writerBusy?: boolean;
  resources?: ResourceSnapshot;
}

export const defaults: GenerationRequest = {
  title: '', lyrics: '', style: '', cot: 'full', abc: '', seed: '',
  num_inference_steps: 32, cfg_scale: 1,
  abc_temperature: .7, abc_top_p: .9, abc_top_k: 30,
  abc_repetition_penalty: 1.005, abc_penalty_window: 100, abc_min_tokens: 32, abc_max_tokens: 4096,
  semantic_temperature: 1, semantic_top_p: .95, semantic_top_k: 100,
  semantic_repetition_penalty: 1.2, semantic_penalty_window: 50, semantic_min_tokens: 200, semantic_max_tokens: 9000,
  backend: 'vulkan', weight_storage: 'q8_0', wait_for_memory: true, threads: 8,
};

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  if (!response.ok) {
    const body = await response.text();
    try { const data = JSON.parse(body); throw new Error(data.error || data.message || body); }
    catch (error) { if (error instanceof SyntaxError) throw new Error(body || `Request failed (${response.status})`); throw error; }
  }
  return response.json();
}

export function timeLabel(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${Math.floor(safe % 60).toString().padStart(2, '0')}`;
}
