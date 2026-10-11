// Browser-only image helpers for the UI iframe; the shared modules must not use these globals.

/** Figma's createImage takes PNG, JPEG, or GIF, so a WebP rendition is decoded and re-encoded as PNG. */
export async function webpToPng(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  // 'default' converts a tagged color space such as Display P3 into the canvas's sRGB, as the console preview shows it;
  // 'none' wrote P3 values unconverted into an untagged sRGB PNG, which shifted color.
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  const canvas = document.createElement('canvas');
  try {
    if (bitmap.width > 4096 || bitmap.height > 4096) throw new Error('too large');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('encode failed');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
    // Releases the canvas's backing store now rather than at garbage collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}
