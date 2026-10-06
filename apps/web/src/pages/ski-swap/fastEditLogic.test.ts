import { describe, expect, it } from 'vitest';
import type { ResolvedAttribute, ResolvedTaxonomy, ResolvedValue } from '../../lib/api.types';
import {
  acceptSuggestion, currentWord, detailsSuggestions, fastEditKey, parseDetails, type KeyContext,
} from './fastEditLogic';

const value = (id: string, label: string, attributes: ResolvedAttribute[] = []): ResolvedValue =>
  ({ id, label, scope: 'global', displayOrder: 0, attributes });
const select = (id: string, label: string, values: ResolvedValue[], displayOrder = 0): ResolvedAttribute =>
  ({ id, label, scope: 'global', input: 'select', displayOrder, nameSlot: 0, values });

const taxonomy: ResolvedTaxonomy = {
  version: 1,
  categories: [
    {
      id: 'skis', label: 'Skis', scope: 'global', displayOrder: 0,
      attributes: [
        select('skis-make', 'Manufacturer', [
          value('ross', 'Rossignol', [select('ross-model', 'Model', [value('exp88', 'Experience 88')])]),
          value('bd', 'Black Diamond'),
        ], 0),
        select('skis-color', 'Color', [value('red', 'Red'), value('black', 'Black')], 1),
        { id: 'skis-len', label: 'Length', scope: 'global', input: 'number', displayOrder: 2, nameSlot: 2 },
      ],
    },
    {
      id: 'boots', label: 'Ski Boots', scope: 'global', displayOrder: 1,
      attributes: [select('boots-make', 'Manufacturer', [value('ross-b', 'Rossignol')])],
    },
    { id: 'jackets', label: 'Jackets', scope: 'global', displayOrder: 2, attributes: [select('jk-color', 'Color', [value('red-j', 'Red')])] },
  ],
};

describe('reading a description (Plan 37 D2, D3)', () => {
  it('names it as the server does, whatever order it was typed in, unmatched words after', () => {
    expect(parseDetails('red skis rossignol 170 demo', taxonomy)).toEqual({
      categoryId: 'skis',
      attributes: [{ attributeId: 'skis-color', valueId: 'red' }, { attributeId: 'skis-make', valueId: 'ross' }],
      name: 'Rossignol Red Skis 170 demo',
      extra: ['170', 'demo'],
    });
    // With nothing left over, exactly the derived name.
    expect(parseDetails('skis red rossignol', taxonomy)).toMatchObject({ name: 'Rossignol Red Skis', extra: [] });
  });

  it('stores, but doesn’t name, an answer to a question with no name slot', () => {
    const quiet: ResolvedTaxonomy = {
      version: 1,
      categories: [{
        id: 'skis', label: 'Skis', scope: 'global', displayOrder: 0,
        attributes: [{ ...select('cond', 'Condition', [value('used', 'Used')]), nameSlot: null }],
      }],
    };
    expect(parseDetails('used skis', quiet)).toMatchObject({
      attributes: [{ attributeId: 'cond', valueId: 'used' }], name: 'Skis', extra: [],
    });
  });

  it('finds the category first or last, and singular or plural', () => {
    expect(parseDetails('jacket red', taxonomy)).toMatchObject({ categoryId: 'jackets', name: 'Red Jackets' });
    expect(parseDetails('red jackets', taxonomy)?.attributes).toEqual([{ attributeId: 'jk-color', valueId: 'red-j' }]);
  });

  it('matches values only against the named category’s questions', () => {
    // "Black Diamond" is a ski maker; on boots it's just words.
    expect(parseDetails('black diamond ski boots', taxonomy)).toEqual({
      categoryId: 'boots', attributes: [], name: 'Ski Boots black diamond', extra: ['black', 'diamond'],
    });
  });

  it('takes the longest label first', () => {
    expect(parseDetails('black diamond skis', taxonomy)?.attributes).toEqual([{ attributeId: 'skis-make', valueId: 'bd' }]);
    expect(parseDetails('ski boots', taxonomy)?.categoryId).toBe('boots');
  });

  it('answers each question once, leaving a second answer in the name', () => {
    expect(parseDetails('red black skis', taxonomy)).toEqual({
      categoryId: 'skis', attributes: [{ attributeId: 'skis-color', valueId: 'red' }], name: 'Red Skis black', extra: ['black'],
    });
  });

  it('opens a value’s follow-up questions, whichever is typed first', () => {
    expect(parseDetails('experience 88 rossignol skis', taxonomy)?.attributes).toEqual([
      { attributeId: 'skis-make', valueId: 'ross' }, { attributeId: 'ross-model', valueId: 'exp88' },
    ]);
    // Without the manufacturer, the model isn't asked.
    expect(parseDetails('experience 88 skis', taxonomy)?.attributes).toEqual([]);
  });

  it('leaves number questions to the name', () => {
    expect(parseDetails('skis 170', taxonomy)).toMatchObject({ attributes: [], name: 'Skis 170', extra: ['170'] });
  });

  it('with no category, is only a name', () => {
    expect(parseDetails('rossignol red', taxonomy)).toEqual({ categoryId: null, attributes: [], name: 'rossignol red', extra: [] });
  });

  it('takes a category from a value picked before any was named, adding it to the name', () => {
    expect(parseDetails('Rossignol red', taxonomy, 'skis')).toEqual({
      categoryId: 'skis',
      attributes: [{ attributeId: 'skis-make', valueId: 'ross' }, { attributeId: 'skis-color', valueId: 'red' }],
      name: 'Rossignol Red Skis',
      extra: [],
    });
    // A category typed after wins over the picked one.
    expect(parseDetails('Rossignol ski boots', taxonomy, 'skis')?.categoryId).toBe('boots');
  });

  it('is nothing for an empty line', () => {
    expect(parseDetails('   ', taxonomy)).toBeNull();
  });
});

describe('reading a description in "Other"', () => {
  const other: ResolvedTaxonomy = {
    version: 1,
    categories: [{
      id: 'other', label: 'Other', scope: 'global', displayOrder: 0,
      attributes: [
        { ...select('what', 'What is it?', [value('sled', 'Sled')], 0), nameSlot: 10, allowFreeEntry: true },
        { ...select('color', 'Color', [value('red', 'Red')], 1), nameSlot: 20 },
      ],
    }],
  };
  it('names it by what it is, not "Other"', () => {
    expect(parseDetails('other sled red', other)).toMatchObject({ name: 'Red Sled', extra: [] });
  });
  it('lets the words that matched nothing say what it is', () => {
    expect(parseDetails('other red boot bag', other)).toMatchObject({ name: 'Red boot bag', extra: ['boot', 'bag'] });
    expect(parseDetails('other red', other)).toMatchObject({ name: 'Red Other' });
  });
});

describe('suggestions', () => {
  const labels = (text: string, implied: string | null = null) =>
    detailsSuggestions(text, text.length, taxonomy, implied).map((s) => `${s.label} (${s.sublabel})`);

  it('offer types first, then any type’s values, saying what each is', () => {
    expect(labels('ro')).toEqual(['Rossignol (Skis · Manufacturer)', 'Rossignol (Ski Boots · Manufacturer)']);
    expect(labels('ski')).toEqual(['Skis (Type)', 'Ski Boots (Type)']);
  });

  it('offer only the category’s unanswered questions once it’s known', () => {
    expect(labels('skis red b')).toEqual(['Black Diamond (Manufacturer)']);
    expect(labels('skis rossignol ex')).toEqual(['Experience 88 (Model)']);
    expect(labels('ro', 'skis')).toEqual(['Rossignol (Manufacturer)']);
  });

  it('offer nothing between words', () => {
    expect(labels('skis ')).toEqual([]);
  });

  it('replace the word being typed', () => {
    expect(currentWord('skis ros', 8)).toEqual({ start: 5, typed: 'ros' });
    expect(acceptSuggestion('skis ros', 8, 'Rossignol')).toEqual({ text: 'skis Rossignol ', cursor: 15 });
    expect(acceptSuggestion('ros skis', 3, 'Rossignol')).toEqual({ text: 'Rossignol skis', cursor: 10 });
  });
});

describe('keys (Plan 37 D5)', () => {
  const ctx = (over: Partial<KeyContext>): KeyContext => ({
    field: 'sku', key: 'Enter', shift: false, suggestionsOpen: false, highlighted: -1, arrowed: false,
    skuExact: false, loaded: false, priceValid: false, empty: false, ...over,
  });

  it('SKU: loads an exact number or an arrowed suggestion, never a partial one', () => {
    expect(fastEditKey(ctx({ skuExact: true }))).toEqual({ do: 'loadExact', then: 'details' });
    expect(fastEditKey(ctx({ key: 'Tab', skuExact: true }))).toEqual({ do: 'loadExact', then: 'details' });
    expect(fastEditKey(ctx({ suggestionsOpen: true, highlighted: 0 }))).toEqual({ do: 'refuseSku' });
    expect(fastEditKey(ctx({ suggestionsOpen: true, highlighted: 2, arrowed: true }))).toEqual({ do: 'loadHighlighted', then: 'details' });
    expect(fastEditKey(ctx({ key: 'Tab' }))).toEqual({ do: 'refuseSku' });
  });

  it('Details: Enter takes a suggestion or moves on; Tab moves on, taking only an arrowed one', () => {
    const d = { field: 'details' as const, loaded: true };
    expect(fastEditKey(ctx({ ...d, suggestionsOpen: true, highlighted: 0 }))).toEqual({ do: 'accept', then: 'stay' });
    expect(fastEditKey(ctx({ ...d }))).toEqual({ do: 'focus', field: 'price' });
    expect(fastEditKey(ctx({ ...d, key: 'Tab', suggestionsOpen: true, highlighted: 0 }))).toEqual({ do: 'focus', field: 'price' });
    expect(fastEditKey(ctx({ ...d, key: 'Tab', suggestionsOpen: true, highlighted: 1, arrowed: true }))).toEqual({ do: 'accept', then: 'price' });
  });

  it('Price: Enter saves once there’s a price and a ticket', () => {
    const p = { field: 'price' as const, loaded: true };
    expect(fastEditKey(ctx({ ...p, priceValid: true }))).toEqual({ do: 'save' });
    expect(fastEditKey(ctx({ ...p }))).toEqual({ do: 'needPrice' });
    expect(fastEditKey(ctx({ field: 'price', priceValid: true }))).toEqual({ do: 'focus', field: 'sku' });
    expect(fastEditKey(ctx({ ...p, key: 'Tab' }))).toEqual({ do: 'none' });
  });

  it('Shift+Tab goes back a field', () => {
    expect(fastEditKey(ctx({ field: 'price', key: 'Tab', shift: true }))).toEqual({ do: 'focus', field: 'details' });
    expect(fastEditKey(ctx({ field: 'details', key: 'Tab', shift: true }))).toEqual({ do: 'focus', field: 'sku' });
    expect(fastEditKey(ctx({ field: 'sku', key: 'Tab', shift: true }))).toEqual({ do: 'none' });
  });

  it('Escape closes suggestions, then clears the ticket, then the dialog', () => {
    expect(fastEditKey(ctx({ key: 'Escape', suggestionsOpen: true }))).toEqual({ do: 'closeSuggestions' });
    expect(fastEditKey(ctx({ key: 'Escape' }))).toEqual({ do: 'clearTicket' });
    expect(fastEditKey(ctx({ key: 'Escape', empty: true }))).toEqual({ do: 'exit' });
  });

  it('arrows move through open suggestions, and typing is left alone', () => {
    expect(fastEditKey(ctx({ key: 'ArrowDown', suggestionsOpen: true }))).toEqual({ do: 'highlight', by: 1 });
    expect(fastEditKey(ctx({ key: 'ArrowUp', suggestionsOpen: true }))).toEqual({ do: 'highlight', by: -1 });
    expect(fastEditKey(ctx({ key: '7' }))).toEqual({ do: 'default' });
  });
});
