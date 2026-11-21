// KaTeX renders an accessibility MathML tree and a separate visual HTML tree.
// Transfer only the mathematical structure, independent of KaTeX CSS and fonts.
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
export const KATEX_OR_MATHML = ".katex-display, .katex, math";
export const RENDERED_MATH = `[data-clipboard-formula], ${KATEX_OR_MATHML}`;
const LATEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';
const MATH_ELEMENTS = [
  "math", "maction", "menclose", "merror", "mfenced", "mfrac", "mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover",
  "mpadded", "mphantom", "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup",
  "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "none",
];
const mathElements = new Set(MATH_ELEMENTS);
const MATH_ATTRIBUTES = [
  "accent", "accentunder", "align", "bevelled", "close", "columnalign", "columnlines", "columnspacing", "columnspan",
  "depth", "dir", "display", "displaystyle", "fence", "form", "frame", "framespacing", "height", "largeop", "linebreak",
  "linethickness", "lspace", "mathbackground", "mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "movablelimits",
  "notation", "open", "rowalign", "rowlines", "rowspacing", "rowspan", "rspace", "scriptlevel", "separator", "separators",
  "stretchy", "symmetric", "voffset", "width",
];

// Used by the Markdown renderer for pasted native MathML. No annotation,
// resource-loading attribute, script, or embedded HTML is allowed here.
export const MATHML_MARKDOWN_TAGS = Object.fromEntries(
  MATH_ELEMENTS.map((tag) => [tag, tag === "math" ? [...MATH_ATTRIBUTES, "xmlns"] : MATH_ATTRIBUTES]),
);

export function formulaSource(element: Element): string | undefined {
  return element.querySelector(LATEX_ANNOTATION)?.textContent?.trim() || undefined;
}

function copyMathElement(element: Element, owner: Document): Element | undefined {
  if (element.namespaceURI !== MATHML_NAMESPACE) return;
  const tag = element.localName;
  // The remaining branches of <semantics> are source annotations, not part
  // of the displayed formula. They also must not leak into plain text.
  if (tag === "semantics") {
    const presentation = element.firstElementChild;
    return presentation ? copyMathElement(presentation, owner) : undefined;
  }
  if (!mathElements.has(tag)) return;
  const result = owner.createElementNS(MATHML_NAMESPACE, tag);
  for (const attribute of MATH_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value != null && !/(?:url\s*\(|[<>{}])/i.test(value)) result.setAttribute(attribute, value);
  }
  if (element.childElementCount) {
    for (const child of element.children) {
      const copy = copyMathElement(child, owner);
      if (copy) result.append(copy);
    }
  } else result.textContent = element.textContent;
  return result;
}

export function copyMath(element: Element, owner: Document): Element | undefined {
  const original = element.matches("math") ? element : element.querySelector("math");
  if (!original) return;
  const math = copyMathElement(original, owner);
  if (!math?.hasChildNodes()) return;
  math.setAttribute("xmlns", MATHML_NAMESPACE);
  if (element.matches(".katex-display, [data-clipboard-formula='block']") || original.getAttribute("display") === "block") {
    math.setAttribute("display", "block");
  }
  return math;
}

export function copySelectedMath(element: Element, owner: Document, range: Range): Node | undefined {
  const visual = element.querySelector(".katex-html") ?? (element.matches("math") ? element : element.querySelector("math"));
  if (!visual) return;
  const walker = visual.ownerDocument.createTreeWalker(visual, 4 /* SHOW_TEXT */);
  let selected = "";
  let hasVisibleGlyphs = false;
  let complete = true;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue ?? "";
    if (!text || node.parentElement?.closest("annotation, annotation-xml, mphantom, .phantom")) continue;
    hasVisibleGlyphs = true;
    if (!range.intersectsNode(node)) {
      complete = false;
      continue;
    }
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : text.length;
    if (start || end !== text.length) complete = false;
    selected += text.slice(start, end);
  }
  if (complete && (hasVisibleGlyphs || range.commonAncestorContainer.contains(element))) return copyMath(element, owner);
  // A visual fragment does not necessarily have a matching MathML subtree
  // (for example just the base of a superscript). Copy only the chosen glyphs.
  return selected ? owner.createTextNode(selected) : undefined;
}

const SUPER = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾";
const SUB = "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎";
const SCRIPT_BASE = "0123456789+-=()";

function plainScript(value: string, upper: boolean) {
  if (!value) return "";
  const mapping = upper ? SUPER : SUB;
  if (Array.from(value).every((character) => SCRIPT_BASE.includes(character))) {
    return Array.from(value, (character) => mapping[SCRIPT_BASE.indexOf(character)]).join("");
  }
  return (upper ? "^(" : "_(") + value + ")";
}

function atomicNode(node: Element | undefined): Element | undefined {
  while (node?.children.length === 1 && (node.localName === "mrow" || node.localName === "mstyle")) {
    node = node.children[0];
  }
  return node;
}

function group(node: Element | undefined, value: string) {
  const tag = atomicNode(node)?.localName;
  const atom = (tag === "mn" && /^\d+(?:\.\d+)?$/.test(value)) || (tag === "mi" && Array.from(value).length === 1);
  return !value || atom ? value : "(" + value + ")";
}

function isJuxtaposedWith(node: Element | undefined, preceding: boolean) {
  const value = atomicNode(node);
  if (!value || value.localName === "mtext") return false;
  if (value.localName !== "mo") return true;
  const operator = value.textContent ?? "";
  return (preceding ? [")", "]", "}"] : ["(", "[", "{"]).includes(operator);
}

function plainSequence(children: Element[], parts: string[]) {
  const significant = children.map((child, index) => child.localName === "mspace" ? -1 : index).filter((index) => index >= 0);
  for (let i = 0; i < significant.length; i += 1) {
    const index = significant[i];
    if (atomicNode(children[index])?.localName !== "mfrac") continue;
    if (isJuxtaposedWith(children[significant[i - 1]], true) || isJuxtaposedWith(children[significant[i + 1]], false)) {
      parts[index] = "(" + parts[index] + ")";
    }
  }
  return parts.join("");
}

export function plainMath(element: Element): string {
  const tag = element.localName;
  if (tag === "mspace") return " ";
  if (tag === "mphantom") return "";
  const children = Array.from(element.children);
  if (!children.length) return element.textContent ?? "";
  const parts = children.map(plainMath);
  const [base = "", first = "", second = ""] = parts;
  const groupedBase = () => group(children[0], base);
  switch (tag) {
    case "mfrac": return groupedBase() + "/" + group(children[1], first);
    case "msqrt": return "√" + group(children.length === 1 ? children[0] : undefined, plainSequence(children, parts));
    case "mroot": return plainScript(first, true) + "√" + groupedBase();
    case "msub": case "munder": return groupedBase() + plainScript(first, false);
    case "msup": case "mover": return groupedBase() + plainScript(first, true);
    case "msubsup": case "munderover": return groupedBase() + plainScript(first, false) + plainScript(second, true);
    case "mtable": return parts.join("; ");
    case "mtr": case "mlabeledtr": return parts.join(", ");
    case "mfenced": return (element.getAttribute("open") ?? "(") + parts.join(", ") + (element.getAttribute("close") ?? ")");
    default: return plainSequence(children, parts);
  }
}
