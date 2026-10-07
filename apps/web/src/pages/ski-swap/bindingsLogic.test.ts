import { describe, expect, it } from 'vitest';
import { answerBadge, filterModels, matchesTokens } from './bindingsLogic';
import type { BindingLookup } from '../../lib/api.types';

const lookup = (over: Partial<BindingLookup>): BindingLookup => ({
  nodeId: 'n', manufacturerId: 'm', manufacturer: 'Maple', model: 'Glade 13 ID', answer: 'indemnified',
  season: '2025-26', lastListedSeason: '2025-26', lines: ['retail'], currentLine: true, nonIso: false,
  program: { key: 'elevate', name: 'Elevate' }, note: null, ...over,
});

describe('answerBadge', () => {
  it('reads each answer with its season and lines', () => {
    expect(answerBadge(lookup({}))).toMatchObject({ label: 'Indemnified', line: 'Listed 2025-26, retail, current line' });
    expect(answerBadge(lookup({ lines: ['retail', 'rental', 'demo'], currentLine: null })).line).toBe('Listed 2025-26, retail, rental and demo');
    expect(answerBadge(lookup({ answer: 'final_season', currentLine: false })).line).toBe('Indemnified through 2025-26, retail; not after');
    expect(answerBadge(lookup({ answer: 'lapsed', lastListedSeason: '2023-24' })).line).toBe('Last listed 2023-24; not on the 2025-26 list');
    expect(answerBadge(lookup({ answer: 'not_listed', season: null, lines: [], currentLine: null })).label).toBe('Not on the list');
    expect(answerBadge(lookup({ answer: 'unavailable', season: null, lines: [], currentLine: null })).label).toBe('Unavailable');
  });
});

describe('matching as the server does', () => {
  it('needs every token to start a token of maker and model', () => {
    expect(matchesTokens('Maple Glade 13 ID', 'gla 13')).toBe(true);
    expect(matchesTokens('Tyrolia ATTACK² 13 GW', 'attack2 13')).toBe(true);
    expect(matchesTokens('Maple Glade 13 ID', 'glade 14')).toBe(false);
  });

  it('narrows a loaded brand, and leaves it whole for an empty query', () => {
    const models = [lookup({ model: 'Glade 13 ID' }), lookup({ model: 'Spruce 10' })];
    expect(filterModels(models, 'spr').map((m) => m.model)).toEqual(['Spruce 10']);
    expect(filterModels(models, '  ')).toHaveLength(2);
  });
});
