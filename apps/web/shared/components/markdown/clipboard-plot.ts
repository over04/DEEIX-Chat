import { portableClipboardColor } from "./clipboard-color";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PLOT_IMAGE_PREFIX = "data:image/svg+xml;charset=utf-8,";
const SHAPES = new Set([
  "svg", "g", "line", "path", "text", "tspan", "rect", "circle", "ellipse", "polygon", "polyline", "defs",
  "clipPath", "pattern", "marker", "linearGradient", "radialGradient", "stop", "title", "desc",
]);
const TEXT_SHAPES = new Set(["text", "tspan", "title", "desc"]);
const LOCAL_REFERENCE_ATTRIBUTES = new Set(["fill", "stroke", "clip-path", "marker-start", "marker-mid", "marker-end"]);
const PAINT_ATTRIBUTES = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "opacity", "stop-color", "stop-opacity", "font-size", "font-weight", "font-family",
  "text-anchor", "dominant-baseline",
];
const SVG_ATTRIBUTES = [
  ...PAINT_ATTRIBUTES, ...LOCAL_REFERENCE_ATTRIBUTES,
  "id", "width", "height", "viewBox", "preserveAspectRatio", "d", "x", "y", "x1", "y1", "x2", "y2", "dx", "dy",
  "cx", "cy", "r", "rx", "ry", "points", "transform", "clipPathUnits", "gradientUnits", "gradientTransform", "offset",
  "patternUnits", "patternTransform", "patternContentUnits", "refX", "refY", "markerWidth", "markerHeight", "markerUnits", "orient",
];

function portableAttribute(name: string, value: string): string | undefined {
  if (!value) return;
  if (/url\s*\(/i.test(value)) {
    const fragment = /^url\(\s*["']?(#[a-z0-9_:.-]+)["']?\s*\)$/i.exec(value)?.[1];
    if (fragment && LOCAL_REFERENCE_ATTRIBUTES.has(name)) return "url(" + fragment + ")";
    return;
  }
  if (/^[a-z0-9_#:.,%()+/\-\s]+$/i.test(value)) return value;
}

// Accept only the inert SVG subset emitted below. This check also runs during
// server rendering, where DOMParser is unavailable. Unrecognized markup and
// attributes (including foreign content, event handlers and hrefs) are rejected.
export function isPortablePlotImage(url: string): boolean {
  if (!url.startsWith(PLOT_IMAGE_PREFIX)) return false;
  let markup: string;
  try {
    markup = decodeURIComponent(url.slice(PLOT_IMAGE_PREFIX.length));
  } catch {
    return false;
  }
  if (!markup.startsWith("<svg ") || !markup.endsWith("</svg>")) return false;
  const tags: string[] = [];
  let cursor = 0;
  for (const token of markup.matchAll(/<[^<>]*>|[^<>]+/g)) {
    if (token.index !== cursor) return false;
    cursor += token[0].length;
    if (!token[0].startsWith("<")) {
      if (!TEXT_SHAPES.has(tags.at(-1) ?? "")) return false;
      continue;
    }
    const close = /^<\/([a-zA-Z]+)>$/.exec(token[0]);
    if (close) {
      if (tags.pop() !== close[1] || (!tags.length && cursor !== markup.length)) return false;
      continue;
    }
    const openingTag = /^<([a-zA-Z]+)((?: [a-zA-Z][a-zA-Z0-9-]*="[^"<>&]*")*)\s*(\/?)>$/.exec(token[0]);
    if (!openingTag) return false;
    const [, tagName, attrs, selfClosing] = openingTag;
    if (!SHAPES.has(tagName)) return false;
    for (const [, name, value] of attrs.matchAll(/ ([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) {
      if (name === "xmlns" && value === SVG_NAMESPACE && tagName === "svg") continue;
      if (!SVG_ATTRIBUTES.includes(name) || !portableAttribute(name, value)) return false;
    }
    if (!selfClosing) tags.push(tagName);
  }
  return !tags.length && cursor === markup.length;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function copyShape(source: Element, owner: Document): Element | undefined {
  if (source.namespaceURI !== SVG_NAMESPACE) return;
  if (!SHAPES.has(source.localName)) {
    // Styles are resolved below. Foreign content cannot be copied as an
    // isolated SVG without dropping part of the visible chart.
    if (source.localName === "foreignObject" || source.localName === "image" || source.localName === "use") {
      throw new Error("The graph contains unsupported embedded content");
    }
    return;
  }
  const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
  if (computed?.display === "none" || computed?.visibility === "hidden") return;
  const shape = owner.createElementNS(SVG_NAMESPACE, source.localName);
  for (const name of SVG_ATTRIBUTES) {
    const value = portableAttribute(name, source.getAttribute(name) ?? "");
    if (value) shape.setAttribute(name, value);
  }
  for (const name of PAINT_ATTRIBUTES) {
    const value = portableAttribute(name, computed?.getPropertyValue(name) ?? "");
    if (value) shape.setAttribute(name, portableClipboardColor(value, source.ownerDocument));
  }
  // SVG animation libraries can position groups with an inline transform.
  const transform = portableAttribute("transform", computed?.getPropertyValue("transform") ?? "");
  if (transform && transform !== "none") shape.setAttribute("transform", transform);
  for (const child of source.childNodes) {
    if (isElement(child)) {
      const copy = copyShape(child, owner);
      if (copy) shape.appendChild(copy);
    } else if (child.nodeType === 3 && TEXT_SHAPES.has(source.localName)) {
      shape.appendChild(owner.createTextNode(child.nodeValue ?? ""));
    }
  }
  return shape;
}

// Only app-rendered graphs reach this exporter. The standalone image contains
// the visible geometry and labels, without scripts, stylesheet or remote URLs.
export function copyPlotImage(source: Element, owner: Document, useVisibleLabels = false): HTMLImageElement | undefined {
  const svg = copyShape(source, owner);
  if (!svg?.hasChildNodes()) return;
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  const view = source.ownerDocument.defaultView;
  const backing = source.closest('[role="img"]') ?? source.parentElement;
  const background = backing && view?.getComputedStyle(backing).backgroundColor;
  if (background && !/^(?:transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(background)) {
    const backdrop = owner.createElementNS(SVG_NAMESPACE, "rect");
    backdrop.setAttribute("width", "100%");
    backdrop.setAttribute("height", "100%");
    backdrop.setAttribute("fill", portableClipboardColor(portableAttribute("fill", background) ?? "white", source.ownerDocument));
    svg.prepend(backdrop);
  }
  const image = owner.createElement("img");
  const label = (source.getAttribute("aria-label") || svg.querySelector("title")?.textContent)?.trim();
  const backingLabel = source.parentElement?.getAttribute("aria-label")?.trim();
  const visibleLabels = Array.from(svg.querySelectorAll("text"), (node) => node.textContent?.trim()).filter(Boolean).join(" · ");
  image.alt = label || (useVisibleLabels ? visibleLabels || backingLabel : backingLabel || visibleLabels) || "";
  const markup = svg.outerHTML.replaceAll("&nbsp;", "&#160;");
  const encoded = encodeURIComponent(markup).replaceAll("(", "%28").replaceAll(")", "%29");
  image.src = PLOT_IMAGE_PREFIX + encoded;
  image.style.maxWidth = "100%";
  return image;
}
