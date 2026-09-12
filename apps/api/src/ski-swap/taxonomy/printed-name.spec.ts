import { CreateItemSchema, PatchItemSchema } from '../../contracts/ski-swap.contracts';

/**
 * Taking the name the printing client derived (handoff Ask K).
 *
 * The iPad prints over Bluetooth at the counter and queues the create, and that
 * queue may not drain for hours. By the time it does, the name is ink on a ski
 * in a rack — so when the client says a tag already exists, it is the authority
 * on what that tag says.
 *
 * The narrow form was taken deliberately: `alreadyPrinted` gates it. A client
 * that has not printed anything has no claim the server's own derivation lacks,
 * and the web preview-then-save path has no race to protect against.
 */

/** What `createAtStation` decides before handing `create` a name. */
function printedNameFor(body: { name?: string; alreadyPrinted?: boolean }): string | undefined {
  return body.alreadyPrinted && body.name ? body.name : undefined;
}

describe('CreateItemSchema', () => {
  const base = { categoryId: 'cat-1', priceCents: 1000, quantity: 1 };

  it('accepts a name beside alreadyPrinted', () => {
    const parsed = CreateItemSchema.parse({
      ...base,
      name: 'Head Kore 112cm Powder Skis',
      alreadyPrinted: true,
    });
    expect(printedNameFor(parsed)).toBe('Head Kore 112cm Powder Skis');
  });

  it('ignores a name with no tag behind it', () => {
    // Parsed, not rejected: a queued row written by an older build may carry one
    // incidentally, and refusing it would strand the whole queue.
    const parsed = CreateItemSchema.parse({ ...base, name: 'Whatever I like' });
    expect(printedNameFor(parsed)).toBeUndefined();
  });

  it('ignores alreadyPrinted with no name, and derives as before', () => {
    const parsed = CreateItemSchema.parse({ ...base, alreadyPrinted: true });
    expect(printedNameFor(parsed)).toBeUndefined();
  });

  it('still requires a category, so the attributes are always checkable', () => {
    // The name decides one column. It does not buy a way past describing the
    // item, because the pointers are what reporting groups by.
    expect(() => CreateItemSchema.parse({ priceCents: 1000, quantity: 1, name: 'A thing' })).toThrow();
  });

  it('bounds the name to what the column holds', () => {
    expect(() => CreateItemSchema.parse({ ...base, name: 'x'.repeat(201) })).toThrow();
    expect(() => CreateItemSchema.parse({ ...base, name: '' })).toThrow();
  });
});

describe('PatchItemSchema', () => {
  it('takes a name on its own, with no flag', () => {
    // An item being patched already exists, so a tag for it may too; an explicit
    // name here is deliberate rather than incidental.
    const parsed = PatchItemSchema.parse({ name: 'Corrected On The Tag' });
    expect(parsed.name).toBe('Corrected On The Tag');
  });

  it('takes a name alongside a redescribe, and the name wins', () => {
    const parsed = PatchItemSchema.parse({
      categoryId: 'cat-1',
      attributes: [{ attributeId: 'a1', valueId: 'v1' }],
      name: 'What The Tag Says',
    });
    expect(parsed.name).toBe('What The Tag Says');
    expect(parsed.attributes).toHaveLength(1);
  });

  it('leaves the name alone when none is sent', () => {
    const parsed = PatchItemSchema.parse({ priceCents: 500 });
    expect(parsed.name).toBeUndefined();
  });
});
