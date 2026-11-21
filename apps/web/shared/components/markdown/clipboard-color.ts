const WIDE_COLOR = /^(?:oklch|oklab|lch|lab|hwb|color)\(/i;
const contexts = new WeakMap<Document, CanvasRenderingContext2D | null>();

// The app's themes use OKLCH, but many rich-text importers only understand
// RGB. Sample those color values in sRGB without copying any rendered pixels.
export function portableClipboardColor(value: string, owner: Document): string {
  if (!WIDE_COLOR.test(value) || !owner.defaultView?.CSS?.supports("color", value)) return value;
  let context = contexts.get(owner);
  if (context === undefined) {
    const canvas = owner.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    context = canvas.getContext("2d", { willReadFrequently: true });
    contexts.set(owner, context);
  }
  if (!context) return value;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return alpha === 255 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}
