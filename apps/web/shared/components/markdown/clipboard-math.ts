// KaTeX renders an accessibility MathML tree and a separate visual HTML tree.
// Transfer only the mathematical structure, independent of KaTeX CSS and fonts.
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
export const KATEX_OR_MATHML = ".katex-display, .katex, math";
export const RENDERED_MATH = `[data-clipboard-formula], ${KATEX_OR_MATHML}`;
export const CLIPBOARD_LATEX = "data-deeix-clipboard-latex";
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
  if (isDisplayFormula(element)) {
    math.setAttribute("display", "block");
  }
  return math;
}

function isDisplayFormula(element: Element): boolean {
  return element.matches(".katex-display, [data-clipboard-formula='block'], math[display='block']") ||
    element.querySelector("math")?.getAttribute("display") === "block";
}

function delimitedLatex(source: string, display: boolean): string {
  return display ? `$$\n${source}\n$$` : `$${source}$`;
}

export function clipboardFormulaMarkdown(element: Element): string | undefined {
  const source = element.getAttribute(CLIPBOARD_LATEX);
  if (!source?.trim() || (element.localName !== "div" && element.localName !== "span")) return;
  return delimitedLatex(source, element.localName === "div");
}

export function copyClipboardFormula(element: Element, owner: Document): Element | undefined {
  const source = formulaSource(element);
  if (!source) return copyMath(element, owner);
  const display = isDisplayFormula(element);
  const formula = owner.createElement(display ? "div" : "span");
  // Keep the source intact when HTML importers fold whitespace. The visible
  // fallback is also TeX, for consumers that strip custom attributes.
  formula.setAttribute(CLIPBOARD_LATEX, source);
  const lines = delimitedLatex(source, display).split("\n");
  for (const [index, line] of lines.entries()) {
    if (index) formula.append(owner.createElement("br"));
    formula.append(line);
  }
  return formula;
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
