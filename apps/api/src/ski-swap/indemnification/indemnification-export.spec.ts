import { entriesCsv, type ExportRow } from '../../../prisma/export-indemnification';
import { parseEntriesCsv } from './indemnification-import';

/** The export writes what the import reads (Plan 44): a private backup round-trips. */
describe('exporting the lists', () => {
  const row = (over: Partial<ExportRow>): ExportRow => ({
    program: 'acme', manufacturer: 'Acme', model: 'Glide 12', season: '2025-26', status: 'LISTED',
    retail: true, rental: false, demo: false, currentLine: true, nonIso: false, source: 'NSSRA', sourceRef: 'List p.3', note: null, ...over,
  });

  it('round-trips through the import, quoting what needs it', () => {
    const rows = [
      row({}),
      row({ model: 'Glide 10, Demo', status: 'FINAL_SEASON', retail: false, rental: true, demo: true, currentLine: null, nonIso: true,
        source: 'MANUFACTURER', sourceRef: null, note: 'Units with the "classic" toe: last season.' }),
    ];
    const { rows: back, errors } = parseEntriesCsv(entriesCsv(rows), new Set(['acme']));
    expect(errors).toEqual([]);
    expect(back.map((r) => [r.model, r.status, r.retail, r.rental, r.demo, r.currentLine, r.nonIso, r.source, r.sourceRef, r.note])).toEqual([
      ['Glide 10, Demo', 'FINAL_SEASON', false, true, true, null, true, 'MANUFACTURER', null, 'Units with the "classic" toe: last season.'],
      ['Glide 12', 'LISTED', true, false, false, true, false, 'NSSRA', 'List p.3', null],
    ]);
  });
});
