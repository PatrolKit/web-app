import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';
import { listenForScans, pickScannerNamed, type Scan, type ScanSymbology } from '../../lib/printing/InateckScannerService';
// The same encoder that draws the barcode on every item tag, so the test reads
// what a tag would carry, not something merely like it.
import { code128BModules } from '../../../../api/src/ski-swap/printing/code128.util';
import { code39Modules } from '../../lib/printing/code39';
import type { SwapScanner } from '../../lib/api.types';

type Step = 'intro' | 'connecting' | 'scan' | 'done';

interface Outcome {
  ok: boolean;
  /** What came back, when something did. A skipped step has none. */
  got: Scan | null;
}

/** One code the scanner is asked to read, and what it is for. */
interface Target {
  label: string;
  /** What the step asks for. */
  prompt: string;
  want: ScanSymbology;
  value: string;
  /** Only legacy tickets: a scanner that can't read it is fine for a swap without them. */
  optional?: boolean;
}

const SYMBOLOGY_NAME: Record<ScanSymbology, string> = {
  qr: 'a QR code',
  code128: 'a Code-128 barcode',
  code39: 'a Code 39 barcode',
  unknown: 'a code with no type',
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Five digits, the shape of a pre-printed legacy ticket number. */
function randomTicketNumber(): string {
  return String(10000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90000));
}

/**
 * Connects to one scanner over Bluetooth, shows it each kind of code a swap
 * uses — a seller's QR, an item tag's Code-128, and a legacy ticket's Code 39 —
 * with fresh values, and checks it reads back exactly those, as the right kind
 * of code. The kind matters as much as the text: it is the only thing that
 * tells a seller's QR from an item tag at the bridge.
 *
 * The browser can only reach a scanner its bridge isn't holding, so the test
 * starts by asking for the bridge to be switched off.
 */
export default function ScannerTestModal({ scanner, onClose }: { scanner: SwapScanner; onClose: () => void }) {
  const [step, setStep] = useState<Step>('intro');
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [lastMiss, setLastMiss] = useState<Scan | null>(null);

  // Fresh each time the test is opened, so a scan of an old screenshot fails.
  const targets = useMemo<Target[]>(() => [
    { label: 'Seller QR code', prompt: 'Scan this seller QR code', want: 'qr', value: `PATROLKIT-SCANNER-TEST-${randomCode(8)}` },
    { label: 'Item tag barcode (Code-128)', prompt: 'Scan this item tag barcode', want: 'code128', value: `TEST-${randomCode(6)}` },
    { label: 'Legacy ticket barcode (Code 39)', prompt: 'Scan this legacy ticket barcode', want: 'code39', value: randomTicketNumber(), optional: true },
  ], []);

  // The Bluetooth callback outlives renders, so it reads where the test is from here.
  const stepRef = useRef<Step>('intro');
  const atRef = useRef(0);
  const missRef = useRef<Scan | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const go = (next: Step) => { stepRef.current = next; setStep(next); };

  useEffect(() => () => stopRef.current?.(), []);

  function record(outcome: Outcome) {
    setOutcomes((prev) => [...prev, outcome]);
    missRef.current = null;
    setLastMiss(null);
    const next = atRef.current + 1;
    if (next < targets.length) { atRef.current = next; setAt(next); }
    else finish();
  }

  function onScan(scan: Scan) {
    if (stepRef.current !== 'scan') return;
    const target = targets[atRef.current];
    if (scan.symbology === target.want && scan.payload === target.value) {
      record({ ok: true, got: scan });
    } else {
      // Stays on the step: a misread is worth another go before calling it.
      missRef.current = scan;
      setLastMiss(scan);
    }
  }

  function skip() {
    record({ ok: false, got: missRef.current });
  }

  function finish() {
    go('done');
    stopRef.current?.();
    stopRef.current = null;
  }

  async function connect() {
    setError('');
    if (!isWebBluetoothSupported()) {
      setError('Testing a scanner needs Chrome or Edge, which can use Bluetooth.');
      return;
    }
    go('connecting');
    try {
      const device = await pickScannerNamed(scanner.bluetoothName);
      stopRef.current = await listenForScans(device, onScan, () => {
        if (stepRef.current === 'scan') {
          setError('The scanner disconnected. Wake it and connect again.');
          go('intro');
        }
      });
      setOutcomes([]);
      missRef.current = null;
      setLastMiss(null);
      atRef.current = 0;
      setAt(0);
      go('scan');
    } catch (err: unknown) {
      go('intro');
      // Closing the picker is not a failure; an empty one usually means the bridge still has it.
      if ((err as { name?: string })?.name !== 'NotFoundError') {
        setError((err as Error)?.message ?? 'Could not connect to the scanner.');
      }
    }
  }

  function close() {
    stopRef.current?.();
    stopRef.current = null;
    onClose();
  }

  const allPassed = outcomes.length === targets.length && outcomes.every((o) => o.ok);
  const requiredPassed = outcomes.length === targets.length && outcomes.every((o, i) => o.ok || targets[i].optional);
  const target = targets[at];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={close}>
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-white font-medium">Test {scanner.name}</h3>
          <p className="text-xs text-gray-500 font-mono">{scanner.bluetoothName}</p>
        </div>

        {(step === 'intro' || step === 'connecting') && (
          <div className="space-y-3">
            <ol className="text-sm text-gray-300 space-y-1.5 list-decimal list-inside">
              {scanner.bridgeDeviceId && (
                <li>
                  Unplug or switch off its bridge{scanner.stationName ? ` at ${scanner.stationName}` : ''}. A scanner
                  holds one Bluetooth link, and while the bridge has it this computer can't reach it.
                </li>
              )}
              <li>Wake the scanner by pressing its trigger.</li>
              <li>Connect, and pick it in the list that opens.</li>
            </ol>
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button
              onClick={connect}
              disabled={step === 'connecting'}
              className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white py-2 rounded text-sm font-medium"
            >
              {step === 'connecting' ? 'Connecting…' : 'Connect to the scanner'}
            </button>
            <p className="text-xs text-gray-500">
              The list only shows a scanner that is awake and free. If it's empty, the bridge most likely still has
              it.
            </p>
          </div>
        )}

        {step === 'scan' && (
          <TargetStep
            title={`${at + 1} of ${targets.length} — ${target.prompt}`}
            code={<TargetCode target={target} />}
            want={target.want}
            wantPayload={target.value}
            miss={lastMiss}
            onSkip={skip}
          />
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <p className={`text-sm font-medium ${allPassed ? 'text-green-400' : requiredPassed ? 'text-amber-400' : 'text-red-400'}`}>
              {allPassed
                ? 'The scanner read all codes successfully.'
                : requiredPassed
                  ? "It reads seller QR codes and item tags, but not legacy tickets. That's fine unless this swap uses legacy tickets."
                  : 'Failed — see below.'}
            </p>
            {targets.map((t, i) => (
              <ResultRow key={t.label} label={t.label} outcome={outcomes[i] ?? null} target={t} />
            ))}
            {scanner.bridgeDeviceId && (
              <p className="text-xs text-gray-500">Plug its bridge back in; it reconnects to the scanner by itself.</p>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={close} className="text-sm text-gray-400 hover:text-white px-3 py-1.5">
            {step === 'done' ? 'Done' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TargetCode({ target }: { target: Target }) {
  if (target.want === 'qr') {
    return <div className="bg-white p-3 rounded inline-block"><QRCode value={target.value} size={180} /></div>;
  }
  const modules = target.want === 'code39' ? code39Modules(target.value) : code128BModules(target.value);
  return <Barcode modules={modules} value={target.value} />;
}

function TargetStep({
  title, code, want, wantPayload, miss, onSkip,
}: {
  title: string;
  code: React.ReactNode;
  want: ScanSymbology;
  wantPayload: string;
  miss: Scan | null;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-white">{title}</p>
      <div className="flex justify-center">{code}</div>
      <p className="text-xs text-gray-500 text-center">Hold the scanner a hand's width from the screen.</p>
      {miss && (
        <div className="text-xs text-amber-400 bg-amber-950/40 rounded p-2 space-y-1">
          <p>{diagnose(miss, want, wantPayload)} Try again, or skip to record it as failed.</p>
        </div>
      )}
      <div className="flex justify-end">
        <button onClick={onSkip} className="text-xs text-gray-400 hover:text-white">Skip</button>
      </div>
    </div>
  );
}

function ResultRow({ label, outcome, target }: { label: string; outcome: Outcome | null; target: Target }) {
  if (!outcome) return null;
  return (
    <div className="text-sm">
      <span className={outcome.ok ? 'text-green-400' : 'text-red-400'}>{outcome.ok ? '✓' : '✗'}</span>{' '}
      <span className="text-gray-200">{label}</span>
      {!outcome.ok && (
        <p className="text-xs text-gray-400 ml-5">
          {outcome.got
            ? diagnose(outcome.got, target.want, target.value)
            : target.want === 'code39'
              ? 'Nothing was read. Code 39 may be switched off on this scanner (see its manual).'
              : 'Nothing was read.'}
        </p>
      )}
    </div>
  );
}

/** What went wrong with a read, in terms someone holding the scanner can act on. */
function diagnose(got: Scan, want: ScanSymbology, wantPayload: string | null): string {
  if (got.symbology === 'unknown') {
    return `It read "${got.payload}" but didn't say what kind of code it was. Code-id output is off on this scanner, `
      + 'so a bridge can\'t tell a seller\'s QR from an item tag. Turn code IDs back on (see the scanner\'s manual).';
  }
  if (got.symbology !== want) {
    return `It read ${SYMBOLOGY_NAME[got.symbology]}, not ${SYMBOLOGY_NAME[want]}.`;
  }
  // Some scanners pass Code 39's start and stop characters through, and a
  // ticket number with asterisks on it matches no item.
  if (want === 'code39' && wantPayload && got.payload === `*${wantPayload}*`) {
    return 'It sent the * start and stop characters with the number, so a legacy ticket would not match its item. '
      + 'Turn off transmitting them in the scanner\'s Code 39 settings (see its manual).';
  }
  return wantPayload
    ? `It read "${got.payload}", not "${wantPayload}". Make sure only the code on screen is in view.`
    : `It read "${got.payload}", which wasn't the code on screen.`;
}

/** A barcode as an SVG, dark bars on white with quiet zones, as on a tag. */
function Barcode({ modules, value }: { modules: boolean[]; value: string }) {
  const quiet = 10;
  // Two pixels a module: whole pixels keep every bar the same width, which a
  // scaled-to-fit SVG would not, and a tag's longest SKU still fits the window.
  const unit = 2;
  const height = 90;
  const width = (modules.length + quiet * 2) * unit;
  return (
    <div className="bg-white p-3 rounded inline-block">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} shapeRendering="crispEdges" role="img" aria-label={`Barcode ${value}`}>
        <rect width={width} height={height} fill="#fff" />
        {modules.map((black, i) => (black ? <rect key={i} x={(quiet + i) * unit} width={unit} height={height} fill="#000" /> : null))}
      </svg>
      <p className="text-center text-xs text-black font-mono mt-1">{value}</p>
    </div>
  );
}
