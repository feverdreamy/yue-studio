import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
  seed: string | number | null | undefined;
  tone?: 'light' | 'dark';
  onError: (message: string) => void;
}

export default function SeedButton({ seed, tone = 'light', onError }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const value = seed == null ? '' : String(seed).trim();
  useEffect(() => { setCopied(false); return () => window.clearTimeout(timer.current); }, [value]);

  async function copy() {
    if (!value) return;
    try {
      let copiedWithClipboard = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(value); copiedWithClipboard = true; }
        catch { /* Restricted browsers may still allow a user-initiated legacy copy. */ }
      }
      if (!copiedWithClipboard) {
        const previous = document.activeElement as HTMLElement | null;
        const field = document.createElement('textarea');
        field.value = value;
        field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.append(field);
        field.select();
        const success = document.execCommand('copy');
        field.remove(); previous?.focus();
        if (!success) throw new Error('Clipboard access is unavailable.');
      }
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2200);
    } catch { onError(`Could not copy the seed. You can select and copy it manually: ${value}`); }
  }

  return <button className={`seed-copy seed-copy--${tone}`} disabled={!value} onClick={() => void copy()} aria-label={value ? `Copy seed ${value}` : 'Seed unavailable'} title={value ? 'Copy this take’s generation seed' : 'This take has no recorded seed'}>
    {copied ? <Check size={12} /> : <Copy size={12} />}<span>{copied ? 'COPIED' : 'SEED'} <b>{value || '—'}</b></span>
  </button>;
}
