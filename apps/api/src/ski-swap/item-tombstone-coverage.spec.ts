import * as fs from 'fs';
import * as path from 'path';

/**
 * `SwapItem` is soft-deleted, so a row that exists is not the same as an item
 * that exists. Thirty-odd reads across sixteen files each have to say so, and
 * forgetting one does not fail anywhere near the forgetting — it sells a
 * withdrawn pair of skis, prints a tag for gear that went home, or tells a
 * volunteer a ticket number is spent.
 *
 * So the reads are checked here rather than trusted. This walks the source,
 * finds every `swapItem` read, and asserts its `where` mentions `deletedAt`.
 *
 * The two exceptions are named below, with the reason. Adding a third means
 * writing down why, in this file, which is the point.
 */
describe('item tombstone coverage', () => {
  const SRC = path.join(__dirname, '..');

  /** Reads. `create`, `update` and `delete` decide their own rows. */
  const READS = /\bswapItem\.(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\b/;

  /**
   * Reads allowed to see a tombstone, and why.
   *
   * Keyed by file, with the count, so removing the reason does not silently
   * widen the exemption to a new call added next to it.
   */
  const EXEMPT: Record<string, { count: number; because: string }> = {
    'ski-swap/item.service.ts': {
      // Two calls, one `where`. `list` builds its filter as a variable and
      // hands it to findMany and count, so neither call reads as filtered from
      // here even though the variable it shares does the conditional.
      count: 2,
      because:
        'The delta. `list` with `updatedSince` is the one read that must return ' +
        'tombstones — it is how a cache learns an item went. Its findMany and ' +
        'count share one `where`, which carries the condition.',
    },
    'ski-swap/payouts/payout-run.service.ts': {
      count: 1,
      because:
        'An item can sell and be deleted afterwards. Filtering here would stop ' +
        'paying a seller for gear that was sold.',
    },
  };

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return sources(full);
      return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') ? [full] : [];
    });
  }

  /**
   * Comments stripped before anything is matched.
   *
   * A comment explaining why a read is exempt must not itself satisfy the check
   * it is explaining — which is how writing down the reasoning would otherwise
   * make the test about the reasoning pass.
   */
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Not `://`, so a URL in a string survives.
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  /**
   * Each read call, as the text from the call up to its closing paren.
   *
   * Brace-counted rather than regexed to the next `)`: a `where` holding an
   * object would end the match early and every nested filter would read as
   * missing.
   */
  function reads(src: string): string[] {
    const out: string[] = [];
    const re = new RegExp(READS.source, 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) {
      let depth = 0;
      let i = src.indexOf('(', m.index);
      const from = i;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(src.slice(from, i + 1));
    }
    return out;
  }

  const files = sources(SRC)
    .map((f) => ({ file: path.relative(SRC, f), src: code(fs.readFileSync(f, 'utf8')) }))
    .filter((f) => READS.test(f.src));

  it('finds the files that read items', () => {
    // The fixture, before the behaviour. A regex that matched nothing would
    // pass every assertion below while checking nothing at all.
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files.flatMap((f) => reads(f.src)).length).toBeGreaterThanOrEqual(30);
  });

  it('every read of an item filters out tombstones, except the two that may not', () => {
    const offenders: string[] = [];

    for (const f of files) {
      const unfiltered = reads(f.src).filter((call) => !call.includes('deletedAt'));
      const allowed = EXEMPT[f.file]?.count ?? 0;
      if (unfiltered.length > allowed) {
        offenders.push(`${f.file}: ${unfiltered.length} unfiltered, ${allowed} allowed`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the exemptions honest', () => {
    // An exemption for a file that no longer reads items is a licence sitting
    // around waiting to cover something it was never granted for.
    for (const file of Object.keys(EXEMPT)) {
      expect(files.map((f) => f.file)).toContain(file);
      expect(EXEMPT[file].because.length).toBeGreaterThan(40);
    }
  });

  it('nothing hard-deletes an item outside the org-wide reset', () => {
    // `remove` tombstones. A stray `delete` would take the row with it and put
    // the twenty-two-minute staleness straight back.
    const deleters = sources(SRC)
      .map((f) => ({ file: path.relative(SRC, f), src: code(fs.readFileSync(f, 'utf8')) }))
      .filter((f) => /\bswapItem\.delete\b|\bswapItem\.deleteMany\b/.test(f.src))
      .map((f) => f.file);

    // Only the danger-zone reset, which wipes the org on purpose.
    expect(deleters).toEqual(['ski-swap/square-config.service.ts']);
  });
});
