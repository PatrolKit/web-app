import { describe, expect, it } from 'vitest';
import { isZipComplete, resolveState, typeState, typeZip, US_STATES } from './address';

/**
 * What a person can type into an address field, and what comes out.
 *
 * The cases that matter are not the tidy ones. They are the browser autofilling
 * a full state name where a code was expected, a pasted ZIP+4, and a half-typed
 * answer that must not be called wrong yet.
 */

describe('typing a state', () => {
  it('upper-cases as it goes, which is the whole ask', () => {
    expect(typeState('vt')).toBe('VT');
  });

  it('drops digits and punctuation rather than holding them', () => {
    expect(typeState('V7T.')).toBe('VT');
  });

  it('keeps a space, because several states have one', () => {
    expect(typeState('new hampshire')).toBe('NEW HAMPSHIRE');
  });

  it('does not truncate to two characters', () => {
    // The obvious rule and the wrong one: autofill hands over a full name on
    // some platforms, and truncating turns Vermont into VE — an address that is
    // wrong and looks deliberate.
    expect(typeState('Vermont')).toBe('VERMONT');
  });
});

describe('resolving a state to what gets stored', () => {
  it('takes a code as it stands', () => {
    expect(resolveState('VT')).toBe('VT');
  });

  it('takes a code somebody typed in lower case', () => {
    expect(resolveState('vt')).toBe('VT');
  });

  it('takes the full name the browser autofilled', () => {
    expect(resolveState('Vermont')).toBe('VT');
  });

  it('takes a two-word name however it was spaced', () => {
    expect(resolveState('new  hampshire ')).toBe('NH');
  });

  it('refuses two letters that are not a state', () => {
    // The reason a length check is not enough: XX is two letters, capitalised,
    // and nowhere.
    expect(resolveState('XX')).toBe('');
  });

  it('refuses a half-typed one', () => {
    expect(resolveState('V')).toBe('');
  });

  it('refuses an empty field', () => {
    expect(resolveState('')).toBe('');
  });

  it('knows the territories and the military codes', () => {
    // Rare, and a form that refuses one refuses somebody with no other answer.
    expect(resolveState('Puerto Rico')).toBe('PR');
    expect(resolveState('gu')).toBe('GU');
    expect(resolveState('AE')).toBe('AE');
  });

  it('covers every state, both ways round', () => {
    for (const [code, name] of Object.entries(US_STATES)) {
      expect(resolveState(code)).toBe(code);
      expect(resolveState(name)).toBe(code);
    }
  });

  it('survives a second pass, so blur can run twice', () => {
    expect(resolveState(resolveState('Vermont'))).toBe('VT');
  });
});

describe('typing a ZIP', () => {
  it('keeps five digits', () => {
    expect(typeZip('05672')).toBe('05672');
  });

  it('keeps the leading zero a number would lose', () => {
    expect(isZipComplete(typeZip('05672'))).toBe(true);
  });

  it('drops letters and punctuation', () => {
    expect(typeZip('0-56 72')).toBe('05672');
  });

  it('takes the first five of a ZIP+4 rather than refusing it', () => {
    // The extra four route mail inside a building; nothing here needs them, and
    // rejecting a correct address for being too precise would be absurd.
    expect(typeZip('05672-1234')).toBe('05672');
  });

  it('cannot be made longer than five', () => {
    expect(typeZip('056721234')).toBe('05672');
  });

  it('is not complete while it is half typed', () => {
    expect(isZipComplete('056')).toBe(false);
    expect(isZipComplete('')).toBe(false);
  });
});
