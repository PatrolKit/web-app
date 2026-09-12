#!/usr/bin/env node
/**
 * Renders every registry icon to a PNG the API can serve (iOS handoff, Ask J).
 *
 * A native client cannot use the registry the way the browser does. The web
 * resolves a key against its own bundle, which costs no request and inherits the
 * surrounding text colour — both of those are facts about a bundler and a DOM,
 * and neither survives the trip to an iPad. There the alternative is a
 * hand-written map from every key to a Font Awesome codepoint in a shipped font,
 * which goes stale the moment the registry grows and needs an App Store release
 * to catch up. So the server serves the marks as images instead.
 *
 * Run from `apps/web`, where Font Awesome Pro already resolves:
 *
 *   pnpm --filter @patrolkit/web icons:render
 *
 * Deliberately not a server dependency. The API's host installs with
 * `npm install --omit=dev` and has no `.npmrc`, so it cannot reach the Pro
 * registry at all — and it should not have to. These bytes never change for a
 * given key, so rendering belongs at authoring time, beside the licence.
 *
 * ── Monochrome with alpha ──────────────────────────────────────────────────
 *
 * iOS draws a PNG with alpha as a *template*: the shape comes from the alpha
 * channel and the colour from the view, which is the native equivalent of the
 * web inheriting `currentColor`. A mark baked in a fixed colour cannot be used
 * that way — black vanishes on the dark theme, white on the light one.
 *
 * Duotone is what makes this interesting. Each glyph is two paths, a secondary
 * and a primary, and Font Awesome draws the secondary at 40% opacity. Flattening
 * both to solid black would destroy the icons where the secondary is a backing
 * shape — `faCircleQuestion` would render as a filled disc with no question mark
 * in it. Writing that opacity into the *alpha* channel instead preserves the
 * duotone reading exactly, and a template tint keeps the ramp.
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
/** Font Awesome Pro resolves here, in the workspace that is licensed for it. */
const require = createRequire(import.meta.url);
/**
 * `sharp` resolves from the API, which already depends on it for item photos.
 * Adding a second copy to the web package would pull a native binary into a
 * workspace that never runs it.
 */
const requireFromApi = createRequire(join(here, '../../api/package.json'));
const sharp = requireFromApi('sharp');

const REGISTRY_TS = join(here, '../src/lib/taxonomyIcons.ts');
const KEYS_TS = join(here, '../../api/src/contracts/taxonomy-icons.ts');
const OUT_DIR = join(here, '../../api/src/ski-swap/taxonomy/assets');

/** The size the uploaded-icon path already normalises to (Plan 19 §4.4). */
const PX = 128;
/** Font Awesome's own default for the secondary layer. */
const SECONDARY_OPACITY = 0.4;

/**
 * The key → glyph mapping, read out of the web registry rather than restated.
 *
 * That file is the source of truth and the compiler already forces it to cover
 * every key; a second copy here would be a second thing to forget.
 */
function readRegistry() {
  const src = readFileSync(REGISTRY_TS, 'utf8');
  const body = src.slice(
    src.indexOf('export const TAXONOMY_ICONS'),
    src.indexOf('export { TAXONOMY_ICON_KEYS }'),
  );
  const pairs = [...body.matchAll(/^\s*'?([a-z0-9-]+)'?\s*:\s*(fa[A-Za-z0-9]+)\s*,/gm)];
  if (pairs.length === 0) throw new Error(`No key → icon pairs parsed from ${REGISTRY_TS}`);
  return new Map(pairs.map((m) => [m[1], m[2]]));
}

/** The contract's key list, so a mark cannot be rendered for a key that is not real. */
function readKeys() {
  const src = readFileSync(KEYS_TS, 'utf8');
  const body = src.slice(src.indexOf('TAXONOMY_ICON_KEYS = ['), src.indexOf('] as const'));
  return [...body.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

function svgFor(icon) {
  const [w, h, , , path] = icon;
  const paths = Array.isArray(path) ? path : [path];
  // Duotone arrives as [secondary, primary]; a single-path style as one.
  const layers =
    paths.length === 2
      ? [
          `<path d="${paths[0]}" fill="#000" fill-opacity="${SECONDARY_OPACITY}"/>`,
          `<path d="${paths[1]}" fill="#000" fill-opacity="1"/>`,
        ]
      : [`<path d="${paths[0]}" fill="#000" fill-opacity="1"/>`];
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${layers.join('')}</svg>`,
  );
}

async function main() {
  const duotone = require('@fortawesome/pro-duotone-svg-icons');
  const registry = readRegistry();
  const keys = readKeys();

  const missing = keys.filter((k) => !registry.has(k));
  if (missing.length) throw new Error(`Keys with no glyph in the registry: ${missing.join(', ')}`);

  // Rendered fresh each run, so a key removed from the contract stops shipping.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  let bytes = 0;
  for (const key of keys) {
    const name = registry.get(key);
    const def = duotone[name];
    if (!def) throw new Error(`${name} (for "${key}") is not in the duotone package`);

    const png = await sharp(svgFor(def.icon))
      // `contain` on a square canvas: glyphs are 512 tall but 512–640 wide, and
      // a client drawing them in a square box should not have to letterbox.
      .resize(PX, PX, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();

    writeFileSync(join(OUT_DIR, `${key}.png`), png);
    bytes += png.length;
  }

  const written = readdirSync(OUT_DIR).length;
  console.log(
    `✓ Rendered ${written} taxonomy icons to api/src/ski-swap/taxonomy/assets ` +
      `(${(bytes / 1024).toFixed(0)}KB total, ${Math.round(bytes / written)}B average)`,
  );
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
