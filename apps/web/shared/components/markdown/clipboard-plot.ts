const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SHAPES = new Set(["svg", "g", "line", "path", "text"]);
const GEOMETRY_ATTRIBUTES = [
  "width", "height", "d", "x", "y", "x1", "y1", "x2", "y2", "fill", "stroke", "stroke-width", "stroke-linecap",
  "stroke-linejoin", "font-size", "text-anchor",
];

function copyShape(source: Element, owner: Document): Element | undefined {
  if (source.namespaceURI !== SVG_NAMESPACE || !SHAPES.has(source.localName)) return;
  const shape = owner.createElementNS(SVG_NAMESPACE, source.localName);
  for (const name of GEOMETRY_ATTRIBUTES) {
    const value = source.getAttribute(name);
    if (value && /^[a-z0-9#.,+\-\s]+$/i.test(value)) shape.setAttribute(name, value);
  }
  if (source.localName === "text") shape.textContent = source.textContent;
  else {
    for (const child of source.children) {
      const copy = copyShape(child, owner);
      if (copy) shape.appendChild(copy);
    }
  }
  return shape;
}

// Export the plotted curves, not the interactive widget or any external SVG
// assets. The presentation attributes are also the on-screen CSS fallbacks.
export function copyPlotImage(source: Element, owner: Document): HTMLImageElement | undefined {
  const svg = copyShape(source, owner);
  if (!svg?.hasChildNodes()) return;
  svg.setAttribute("xmlns", SVG_NAMESPACE);
  const backdrop = owner.createElementNS(SVG_NAMESPACE, "rect");
  backdrop.setAttribute("width", "100%");
  backdrop.setAttribute("height", "100%");
  backdrop.setAttribute("fill", "white");
  svg.prepend(backdrop);
  const image = owner.createElement("img");
  image.alt = source.parentElement?.getAttribute("aria-label") ?? "";
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg.outerHTML);
  image.style.maxWidth = "100%";
  return image;
}
