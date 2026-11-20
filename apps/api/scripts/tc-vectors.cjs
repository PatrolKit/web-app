// Generates the fold and sweep vectors from the server's own code, read-only (iOS Plan 43).
//
//   node apps/api/scripts/tc-vectors.cjs [server repo] [out dir]
//
// With no arguments it rewrites src/time-clock/__vectors__, which time-clock-vectors.spec.ts
// checks. The iPad keeps the same two files, byte for byte, in PatrolKitTests/Fixtures: after
// a change to the fold or the sweep, regenerate and copy both there too.
const fs = require('fs');
const path = require('path');
const SERVER = process.argv[2] ?? path.resolve(__dirname, '../../..');
const OUT = process.argv[3] ?? path.resolve(__dirname, '../src/time-clock/__vectors__');
const ts = require(path.join(SERVER, 'node_modules/typescript'));
function load(file, stubs) {
  const src = fs.readFileSync(path.join(SERVER, 'apps/api/src/time-clock', file), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, experimentalDecorators: true } }).outputText;
  const mod = { exports: {} };
  const req = (name) => { if (name in stubs) return stubs[name]; throw new Error('unexpected require ' + name); };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  return mod.exports;
}
const fold = load('fold.service.ts', {
  '@nestjs/common': { Injectable: () => (t) => t },
  '@prisma/client': {},
  '../prisma/prisma.service': { PrismaService: class {} },
});
const sweep = load('sweep.util.ts', {});

const ci = (id, at, o = {}) => ({ id, resortId: 'resort-1', type: 'clock_in', dutyType: 'patrol', dutyNote: null, source: 'device', occurredAt: at, ...o });
const co = (id, at, entryId, o = {}) => ({ id, resortId: 'resort-1', type: 'clock_out', dutyType: null, dutyNote: null, source: 'device', occurredAt: at, entryId, ...o });
// A server sweep (Plan 59 R4, R5): closes at its auto time, placed at its sweep moment.
const sw = (entryId, at, sweepAt, n = 1) => co(`sweep:${entryId}:${n}`, at, entryId, { source: 'auto', sweepAt });

// Times are UTC; 13:00Z is 08:00 in New York, and 08:00Z next day is its 03:00 sweep.
const cases = [
  // The standard flows.
  ['lone clock-in opens an entry', [ci('a', '2026-01-10T13:00:00Z')]],
  ['in and out on one iPad', [ci('a', '2026-01-10T13:00:00Z'), co('b', '2026-01-10T21:00:00Z', 'a')]],
  ['in and out on the phone', [ci('a', '2026-01-10T13:00:00Z', { source: 'member' }), co('b', '2026-01-10T21:00:00Z', 'a', { source: 'member' })]],
  ['in on the iPad, out on the phone', [ci('a', '2026-01-10T13:00:00Z'), co('b', '2026-01-10T21:00:00Z', 'a', { source: 'member' })]],
  ['in on the phone, out on the iPad', [ci('a', '2026-01-10T13:00:00Z', { source: 'member' }), co('b', '2026-01-10T21:00:00Z', 'a')]],
  ['duty type and note carry over', [ci('a', '2026-01-10T13:00:00Z', { dutyType: 'other', dutyNote: 'Helping with the race' })]],
  ['arrival order does not matter', [co('b', '2026-01-10T19:00:00Z', 'a'), ci('a', '2026-01-10T13:00:00Z')]],
  ['a multi-day log', [ci('d1', '2026-01-10T13:00:00Z'), co('d1x', '2026-01-10T21:00:00Z', 'd1'), ci('d2', '2026-01-11T13:30:00Z'), co('d2x', '2026-01-11T20:00:00Z', 'd2'), ci('d3', '2026-01-12T14:00:00Z')]],
  ['an admin close is not flagged', [ci('a', '2026-01-10T13:00:00Z'), co('admin-close:a', '2026-01-10T17:00:00Z', 'a', { source: 'admin' })]],
  ['ties break by id', [ci('a', '2026-01-10T13:00:00Z'), co('x', '2026-01-10T19:00:00Z', 'a'), co('w', '2026-01-10T19:00:00Z', 'a')]],
  // One shift at a time (R2) and naming the shift (R3).
  ['a clock-in at the same resort is a duplicate (E17)', [ci('a', '2026-01-10T13:00:00Z', { source: 'member' }), ci('b', '2026-01-10T13:05:00Z')]],
  ['a clock-in at another resort is a duplicate (E19)', [ci('a', '2026-01-10T13:00:00Z'), ci('b', '2026-01-11T04:00:00Z', { resortId: 'resort-2' })]],
  ['a clock-in at the same instant is a duplicate (E9)', [ci('a', '2026-01-10T13:00:00Z'), ci('b', '2026-01-10T13:00:00Z', { resortId: 'resort-2', source: 'member' })]],
  ['an earlier clock-in arriving late opens the shift (E20)', [ci('phone', '2026-01-10T14:00:00Z', { source: 'member' }), ci('ipad', '2026-01-10T13:00:00Z')]],
  ['a clock-out naming a duplicate closes its shift', [ci('a', '2026-01-10T13:00:00Z', { source: 'member' }), ci('b', '2026-01-10T13:05:00Z'), co('bx', '2026-01-10T21:00:00Z', 'b')]],
  ['a clock-out naming a closed shift is an orphan', [ci('a', '2026-01-10T13:00:00Z'), co('ax', '2026-01-10T20:00:00Z', 'a', { source: 'member' }), ci('b', '2026-01-10T22:00:00Z'), co('late', '2026-01-10T23:00:00Z', 'a')]],
  ['a clock-out with nothing open is an orphan', [co('b', '2026-01-10T19:00:00Z', 'a')]],
  ['a clock-out before its clock-in is an orphan', [ci('a', '2026-01-10T13:00:00Z'), co('b', '2026-01-10T12:00:00Z', 'a')]],
  // The earliest close wins (R4), with a sweep placed at its sweep moment.
  ['the earliest close beats a staff close (E4)', [ci('a', '2026-01-10T13:00:00Z'), co('admin-close:a', '2026-01-10T21:00:00Z', 'a', { source: 'admin' }), co('m', '2026-01-10T20:00:00Z', 'a')]],
  ['the earliest close beats a deactivation (E15)', [ci('a', '2026-01-10T13:00:00Z'), co('admin-deactivate:a', '2026-01-10T21:00:00Z', 'a', { source: 'admin' }), co('m', '2026-01-10T20:00:00Z', 'a')]],
  ['a sweep closes a forgotten shift, flagged', [ci('a', '2026-01-10T13:00:00Z'), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z')]],
  ['a clock-out before the sweep moment beats the sweep (E3)', [ci('a', '2026-01-10T13:00:00Z'), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z'), co('m', '2026-01-10T21:00:00Z', 'a')]],
  ['a clock-out after the sweep moment is too late (E12)', [ci('a', '2026-01-10T13:00:00Z'), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z'), co('m', '2026-01-11T08:01:00Z', 'a', { source: 'member' })]],
  ['a staff close dated after the sweep moment loses to the sweep', [ci('a', '2026-01-10T13:00:00Z'), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z'), co('admin-close:a', '2026-01-11T10:00:00Z', 'a', { source: 'admin' })]],
  ['a duplicate before the sweep does not stop it (E19)', [ci('a', '2026-01-10T13:00:00Z'), ci('b', '2026-01-11T04:00:00Z', { resortId: 'resort-2' }), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z')]],
  ['a reopened shift is swept again (E11)', [ci('a', '2026-01-10T13:00:00Z'), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z', 1), sw('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z', 2)].map((e) => (e.id === 'sweep:a:1' ? { ...e, status: 'voided' } : e))],
  // Only the server sweeps (R5).
  ["an iPad's auto clock-out changes nothing (E14)", [ci('a', '2026-01-10T13:00:00Z'), co('auto:a', '2026-01-10T17:00:00Z', 'a', { source: 'device_auto' })]],
  // Patrollers (R9) and staff edits (R2).
  ['a clock-in from someone inactive is flagged (E16)', [ci('a', '2026-01-10T15:00:00Z', { statusNote: 'inactive_patroller' })]],
  ['a staff correction keeps a duplicate a duplicate (E26)', [ci('lodge', '2026-01-10T13:00:00Z'), ci('summit', '2026-01-11T04:00:00Z', { resortId: 'resort-2', status: 'voided', statusNote: 'kept_duplicate', entryId: 'lodge' }), co('sweep:lodge:1', '2026-01-10T21:00:00Z', 'lodge', { source: 'admin', sweepAt: '2026-01-11T08:00:00Z' })]],
];

const toFold = (e) => ({ ...e, occurredAt: new Date(e.occurredAt), sweepAt: e.sweepAt ? new Date(e.sweepAt) : null });
const iso = (d) => (d ? d.toISOString().replace('.000Z', 'Z') : null);
const foldVectors = cases.map(([name, events]) => {
  const { entries, eventStatus } = fold.foldEvents(events.map(toFold));
  return {
    name,
    events,
    entries: entries.map((e) => ({ id: e.id, resortId: e.resortId, dutyType: e.dutyType, dutyNote: e.dutyNote, clockInAt: iso(e.clockInAt), clockOutAt: iso(e.clockOutAt), status: e.status, closeReason: e.closeReason, flagged: e.flagged, closeEventId: e.closeEventId })),
    eventStatus: Object.fromEntries([...eventStatus.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
});

// Sweep vectors: clock-ins as local wall times in a zone, under a policy.
const local = (y, mo, d, h, mi, s, tz) => new Date(sweep.instantForLocal(y, mo, d, h, mi, tz).getTime() + s * 1000);
const sweepCases = [];
for (const tz of ['America/New_York', 'America/Denver']) {
  const add = (name, at, policy = ['03:00', 4]) => {
    const [time, hours] = policy;
    sweepCases.push({ name: `${name} (${tz})`, timeZone: tz, clockInAt: iso(at), autoCloseLocalTime: time, autoCloseAfterHours: hours,
      sweepAt: iso(sweep.sweepAt(at, tz, time)), clockOutAt: iso(sweep.autoClockOutAt(at, tz, time, hours)) });
  };
  add('daytime', local(2026, 1, 12, 8, 0, 0, tz));
  add('late evening, the 4h rule', local(2026, 1, 12, 22, 30, 0, tz));
  add('late evening, the sweep time', local(2026, 1, 12, 23, 30, 0, tz));
  add('after midnight', local(2026, 1, 13, 0, 45, 0, tz));
  add('a minute before the sweep', local(2026, 1, 13, 2, 59, 0, tz));
  add('the sweep instant', local(2026, 1, 13, 3, 0, 0, tz));
  add('just after the sweep', local(2026, 1, 13, 3, 0, 30, tz));
  add('the day before spring-forward', local(2026, 3, 7, 8, 0, 0, tz));
  add('the evening before spring-forward', local(2026, 3, 7, 23, 30, 0, tz));
  add('the day before fall-back', local(2026, 10, 31, 8, 0, 0, tz));
  add('the evening before fall-back', local(2026, 10, 31, 23, 30, 0, tz));
  add('a 02:00 / 6h policy, daytime', local(2026, 1, 12, 8, 0, 0, tz), ['02:00', 6]);
  add('a 02:00 / 6h policy, evening', local(2026, 1, 12, 21, 0, 0, tz), ['02:00', 6]);
}

const header = 'Generated from the server\'s foldEvents and sweep.util.ts (iOS Plan 43 §4.4, server Plan 59 §3). Both repos keep this file byte for byte; regenerate, do not hand-edit.';
fs.writeFileSync(path.join(OUT, 'time-clock-fold-vectors.json'), JSON.stringify({ about: header, cases: foldVectors }, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'time-clock-sweep-vectors.json'), JSON.stringify({ about: header, cases: sweepCases }, null, 2) + '\n');
console.log(`${foldVectors.length} fold cases, ${sweepCases.length} sweep cases`);
