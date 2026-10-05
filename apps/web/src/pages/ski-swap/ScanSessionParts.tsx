import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faScannerGun as faScannerGunDuo, faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { useScanner } from '../../contexts/ScannerContext';

/**
 * What the scanning popovers share (Plan 40's Batch add, and Scan Ticket):
 * the big banners, the scanner's state said so it can't be missed, and the
 * tone for a refused scan. One look, one set of words, in both.
 */

/** A short, low double beep for a refused or unknown scan. Made here; no sound file. */
export function errorTone() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [0, 0.18].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 220;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.15);
    });
    setTimeout(() => void ctx.close(), 600);
  } catch { /* no audio: the red message still says it */ }
}

/** A banner that can't be missed: red for trouble, green for "go" and "done" (not the brand's red). */
export function Banner({ tone, icon, title, text, action }: {
  tone: 'error' | 'ready';
  icon: Parameters<typeof FontAwesomeIcon>[0]['icon'];
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  const look = tone === 'error'
    ? 'bg-red-950/60 border-red-800 text-red-200'
    : 'bg-green-950/40 border-green-800 text-white';
  return (
    <div className={`shrink-0 border rounded-lg px-4 py-3 flex items-center gap-4 ${look}`} role={tone === 'error' ? 'alert' : 'status'}>
      <FontAwesomeIcon icon={icon} className={`text-3xl shrink-0 ${tone === 'error' ? 'text-red-400' : 'text-green-400'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-lg font-semibold">{title}</p>
        <p className="text-sm opacity-80">{text}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * The scanner's state, prominently: can't scan here, none set up, not
 * connected (with Connect), or ready. `ready` is what "go" says on this screen.
 */
export function ScannerBanner({ ready }: { ready: { title: string; text: string } }) {
  const scanner = useScanner();
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect() {
    setConnectError(null);
    try {
      await scanner.connect();
    } catch (err: unknown) {
      setConnectError((err as { name?: string })?.name === 'NotFoundError'
        ? 'No scanner picked. If nothing was listed, it’s asleep, out of range, or held by a bridge. Press its trigger to wake it, and try again.'
        : (err as Error)?.message ?? 'Could not connect to the scanner.');
    }
  }

  if (!scanner.isSupported) {
    return <Banner tone="error" icon={faTriangleExclamationDuo} title="This browser can’t use a scanner"
      text="Scanning needs Chrome or Edge, which can use Bluetooth. You can still type numbers below." />;
  }
  if (scanner.scanners.length === 0) {
    return <Banner tone="error" icon={faTriangleExclamationDuo} title="No scanner set up"
      text="Add one on the Hardware page. You can still type numbers below." />;
  }
  if (!scanner.connected) {
    return (
      <Banner tone="error" icon={faTriangleExclamationDuo} title="Scanner not connected"
        text={connectError ?? 'Connect it to start scanning. Nothing so far is lost.'}
        action={
          <button type="button" onClick={() => void connect()} disabled={scanner.connecting}
            className="bg-red-700 hover:bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium disabled:opacity-50">
            {scanner.connecting ? 'Connecting…' : 'Connect scanner'}
          </button>
        } />
    );
  }
  return <Banner tone="ready" icon={faScannerGunDuo} title={ready.title} text={ready.text} />;
}

/** The small box for a code whose barcode won't read. */
export function TypedCode({ placeholder, onEnter, button = 'Add' }: { placeholder: string; onEnter: (code: string) => void; button?: string }) {
  const [typed, setTyped] = useState('');
  return (
    <form className="flex gap-2 shrink-0" onSubmit={(e) => { e.preventDefault(); onEnter(typed); setTyped(''); }}>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-sm text-white font-mono"
      />
      <button type="submit" disabled={!typed.trim()} className="bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm disabled:opacity-40">
        {button}
      </button>
    </form>
  );
}
