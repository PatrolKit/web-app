import { GlobalFonts } from '@napi-rs/canvas';

/**
 * The browser asks for Helvetica; the deployment host has **no fonts installed
 * at all**, so text would silently render as nothing there while looking fine
 * on a developer's Mac. Registering a bundled face makes rendering identical
 * everywhere, which is also what makes golden-image tests meaningful.
 *
 * Inter is already the product's typeface in the mail templates, and it is
 * drawn for legibility at small sizes — which is the whole job on a 203 dpi
 * thermal label.
 */
export const LABEL_FONT = 'Inter';

let registered = false;

export function ensureLabelFonts(): void {
  if (registered) return;
  const regular = require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff');
  const bold = require.resolve('@fontsource/inter/files/inter-latin-700-normal.woff');
  GlobalFonts.registerFromPath(regular, LABEL_FONT);
  GlobalFonts.registerFromPath(bold, LABEL_FONT);
  registered = true;
}

/** `font` shorthand in the weight/size the templates ask for. */
export function labelFont(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight === 'bold' ? 'bold ' : ''}${size}px ${LABEL_FONT}`;
}
