/** Longest edge, in pixels, after downscaling. Plenty for a catalogue thumbnail. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/**
 * Shrinks a camera photo before upload.
 *
 * A photo straight off a modern phone is several megabytes, and venue wifi is
 * the worst network the product ever runs on. Downscaling in the browser turns
 * a slow, failure-prone upload into a fast one, and the server only ever shows
 * these at thumbnail size anyway.
 *
 * Returns the original file untouched if anything goes wrong — a photo that
 * uploads slowly beats no photo at all.
 */
export async function downscaleImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_500_000) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;

    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
