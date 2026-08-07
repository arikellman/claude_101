/**
 * Client-side image preparation. Must match the Phase 0 pipeline (../../estimate.py)
 * exactly, or estimation bias shifts between the validated baseline and the app - which
 * is precisely what plan section 3.1 warns against.
 *
 *   - EXIF orientation applied (phone photos carry a rotation flag, not rotated pixels;
 *     a sideways plate measurably degrades identification and portion estimates)
 *   - long edge capped at 1100px
 *   - re-encoded as JPEG quality 85
 */

export const MAX_EDGE = 1100;
export const JPEG_QUALITY = 0.85;

export interface Prepared {
  blob: Blob;
  width: number;
  height: number;
  /** Object URL for immediate optimistic display. Revoke when done. */
  previewUrl: string;
}

export async function prepareImage(file: File | Blob): Promise<Prepared> {
  // createImageBitmap applies EXIF orientation natively when asked, which avoids
  // hand-rolling the orientation matrix. Supported in Chrome on Android.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    // Older engines: fall back to default orientation rather than failing the capture.
    bitmap = await createImageBitmap(file);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Best available resampling. Matches PIL's LANCZOS closely enough for this purpose.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas encoding failed"))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });

  return { blob, width, height, previewUrl: URL.createObjectURL(blob) };
}
