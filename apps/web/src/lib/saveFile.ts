/**
 * Saves a file the page fetched, as a download.
 *
 * API downloads are fetched rather than linked: the session token travels in
 * a header, which a plain link can't carry.
 */
export function saveFile(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}
