const RASTER_IMAGE_DATA = /^data:image\/(?:avif|bmp|gif|jpe?g|png|webp);base64,[a-z0-9+/=]+$/i;
const objectImages = new Map<string, string>();

export class ClipboardImageUnavailable extends Error {
  constructor() {
    super("The selected image is not available in a portable clipboard format");
  }
}

export function isPortableRasterImage(value: string) {
  return RASTER_IMAGE_DATA.test(value);
}

export function clipboardObjectImage(objectURL: string): string {
  const dataURL = objectImages.get(objectURL);
  if (!dataURL) throw new ClipboardImageUnavailable();
  return dataURL;
}

// The native copy event is synchronous. Prepare the bytes already downloaded
// for rendering, without fetching a private URL again or exporting credentials.
export async function prepareClipboardObjectImage(objectURL: string, blob: Blob, signal: AbortSignal) {
  if (signal.aborted || !/^image\/(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(blob.type)) return;
  const dataURL = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    const abort = () => reader.abort();
    function done() {
      signal.removeEventListener("abort", abort);
      resolve(typeof reader.result === "string" ? reader.result : undefined);
    }
    reader.addEventListener("loadend", done, { once: true });
    signal.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(blob);
    } catch {
      done();
    }
  });
  if (!signal.aborted && dataURL && isPortableRasterImage(dataURL)) objectImages.set(objectURL, dataURL);
}

export function forgetClipboardObjectImage(objectURL: string) {
  objectImages.delete(objectURL);
}
