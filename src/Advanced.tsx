import { RotateCcw } from 'lucide-react';
import { defaults, type GenerationRequest } from './types';

type NumberKey = { [K in keyof GenerationRequest]: GenerationRequest[K] extends number ? K : never }[keyof GenerationRequest];
interface FieldProps { label: string; value: number; onChange: (value: number) => void; min: number; max?: number; step?: number; note?: string; }
function NumberField({ label, value, onChange, min, max, step = 1, note }: FieldProps) {
  return <label className="number-field"><span>{label}</span><input type="number" value={value} min={min} max={max} step={step} onChange={event => onChange(Number(event.target.value))} />{note && <small>{note}</small>}</label>;
}

export default function Advanced({ request, update }: { request: GenerationRequest; update: (updates: Partial<GenerationRequest>) => void }) {
  function field(key: NumberKey, label: string, min: number, max?: number, step?: number, note?: string) {
    return <NumberField key={key} label={label} value={request[key]} onChange={value => update({ [key]: value })} min={min} max={max} step={step} note={note} />;
  }
  function sampling(prefix: 'abc' | 'semantic') {
    return <div className="sampling-grid">
      {field(`${prefix}_temperature`, 'Temperature', .01, 5, .01)}
      {field(`${prefix}_top_p`, 'Top P', .01, 1, .01)}
      {field(`${prefix}_top_k`, 'Top K', 1, 100000, 1)}
      {field(`${prefix}_repetition_penalty`, 'Repetition penalty', .001, 100, .001)}
      {field(`${prefix}_penalty_window`, 'Penalty window', 1, 100000, 1)}
      {field(`${prefix}_min_tokens`, 'Minimum tokens', 0, prefix === 'abc' ? 4096 : 9000, 1)}
      {field(`${prefix}_max_tokens`, 'Maximum tokens', 1, prefix === 'abc' ? 4096 : 9000, 1)}
    </div>;
  }
  return <div className="advanced-content">
    <div className="advanced-intro"><p>The small decisions behind the sound.<br /><span>Defaults are a useful starting point. Each take keeps its complete settings.</span></p><button className="text-button" onClick={() => {
      const keys = Object.keys(defaults).filter(key => /^(abc_|semantic_|num_inference|cfg_|threads|backend|weight_storage)/.test(key));
      const values = Object.fromEntries(keys.map(key => [key, defaults[key as keyof GenerationRequest]]));
      update({ ...values, semantic_max_tokens: 1125, cfg_scale: request.cot === 'off' ? 1.01 : 1 });
    }}><RotateCcw size={13} /> Reset controls</button></div>
    <div className="advanced-group"><div className="group-heading"><span className="section-index">01</span><h3>Rendering</h3><span>Audio synthesis</span></div><div className="render-grid">
      {field('num_inference_steps', 'Inference steps', 1, 100, 1, 'Acoustic flow sampling steps.')}
      {field('cfg_scale', 'Guidance', 0, 20, .01, 'Semantic guidance strength.')}
      <label className="number-field"><span>GPU memory</span><select value={request.weight_storage} onChange={e => update({ weight_storage: e.target.value as 'q8_0' | 'native' })}><option value="q8_0">Efficient Q8</option><option value="native">Original storage</option></select><small>Efficient Q8 reduces GPU memory for longer songs. Duration and steps stay the same.</small></label>
      <label className="number-field"><span>Duration ceiling</span><select value={request.semantic_max_tokens} onChange={e => update({ semantic_max_tokens: Number(e.target.value), semantic_min_tokens: Math.min(request.semantic_min_tokens, Number(e.target.value)) })}>{![750, 1125, 1500, 3000, 4500, 6000, 9000].includes(request.semantic_max_tokens) && <option value={request.semantic_max_tokens}>Custom ({Math.round(request.semantic_max_tokens / 25)}s limit)</option>}<option value={750}>Up to 30 seconds</option><option value={1125}>Up to 45 seconds</option><option value={1500}>Up to 1 minute</option><option value={3000}>Up to 2 minutes</option><option value={4500}>Up to 3 minutes</option><option value={6000}>Up to 4 minutes</option><option value={9000}>Up to 6 minutes</option></select><small>Token limit; the model can finish earlier.</small></label>
      <label className="number-field"><span>Seed</span><div className="seed-control"><input aria-label="Generation seed" value={request.seed} inputMode="numeric" pattern="[0-9]*" placeholder="Random each take" onChange={e => { if (/^\d*$/.test(e.target.value)) update({ seed: e.target.value }); }} /><button aria-label="Choose a random fixed seed" title="Choose a random fixed seed" onClick={() => update({ seed: String(crypto.getRandomValues(new Uint32Array(1))[0]) })}>↻</button></div><small>Blank chooses a new seed. 0–4294967295.</small></label>
    </div></div>
    <div className="advanced-group"><div className="group-heading"><span className="section-index">02</span><h3>Musical sampling</h3><span>Semantic audio tokens</span></div>{sampling('semantic')}</div>
    <div className={`advanced-group ${request.cot === 'off' ? 'muted-group' : ''}`}><div className="group-heading"><span className="section-index">03</span><h3>Score planning</h3><span>{request.cot === 'off' ? 'Used in the two planning modes' : 'ABC notation tokens'}</span></div>{sampling('abc')}</div>
    <div className="advanced-group"><div className="group-heading"><span className="section-index">04</span><h3>Local engine</h3><span>Compute settings</span></div><div className="engine-grid"><label className="number-field"><span>Backend</span><select value={request.backend} onChange={e => update({ backend: e.target.value as 'vulkan' | 'cpu' })}><option value="vulkan">Vulkan · GPU</option><option value="cpu">CPU</option></select></label>{field('threads', 'CPU threads', 1, 32, 1)}<p className="field-note">These settings select local processing. They do not send your composition to a hosted music service.</p></div></div>
  </div>;
}

