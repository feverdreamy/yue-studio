import { useEffect, useRef, useState } from 'react';
import { FileUp, Music2, X } from 'lucide-react';
import { renderAbc } from 'abcjs';
import exampleAbc from '../examples/example.abc?raw';

export default function ScoreInput({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const preview = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'source' | 'preview'>('source');
  useEffect(() => {
    if (!preview.current || tab !== 'preview') return;
    preview.current.replaceChildren();
    if (!value.trim()) { const hint = document.createElement('p'); hint.textContent = 'Import or write ABC notation to see your score here.'; preview.current.append(hint); return; }
    try { renderAbc(preview.current, value, { responsive: 'resize', paddingtop: 12, paddingbottom: 12 }); setError(''); }
    catch { setError('This ABC could not be drawn. Check its header and notation.'); }
  }, [value, tab]);
  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 190_000) { setError('Choose a smaller ABC file (at most 64,000 characters).'); return; }
    const text = await file.text();
    if (text.length > 64_000) { setError('The score is too long. Use at most 64,000 characters.'); return; }
    onChange(text); setError('');
    if (fileInput.current) fileInput.current.value = '';
  }
  return <div className={`score-input ${disabled ? 'score-disabled' : ''}`}>
    <div className="score-toolbar">
      <div className="mini-tabs"><button className={tab === 'source' ? 'selected' : ''} onClick={() => setTab('source')}>ABC source</button><button ref={previewButton} className={tab === 'preview' ? 'selected' : ''} onClick={() => setTab('preview')}><Music2 size={12} /> Score preview</button></div>
      <div className="score-actions">{!value.trim() && <button onClick={() => { onChange(exampleAbc); setTab('preview'); setError(''); previewButton.current?.focus(); }}>Try an example</button>}<button onClick={() => fileInput.current?.click()}><FileUp size={13} /> Import</button>{value && <button aria-label="Clear input score" onClick={() => onChange('')}><X size={13} /></button>}</div>
    </div>
    <input ref={fileInput} type="file" accept=".abc,.txt,text/plain" hidden onChange={e => void readFile(e.target.files?.[0])} />
    {tab === 'source' ? <textarea aria-label="ABC score input" maxLength={64000} value={value} spellCheck={false} onChange={e => onChange(e.target.value)} placeholder={'X:1\nT:Your melody\nM:4/4\nL:1/8\nK:C\nC2 E2 G2 c2 |'} /> : <div className="score-preview" ref={preview}>{!value && <p>Import or write ABC notation to see your score here.</p>}</div>}
    <p className="field-note">{disabled ? 'Select Melody or Melody + chords to use this score. Your input is preserved.' : 'Optional: guide the performance with your own notation. Preview shows this input, not a transcription of the audio.'}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
