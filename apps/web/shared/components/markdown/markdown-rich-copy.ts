import { type RichClipboardContent, setRichClipboardData } from "../../lib/clipboard";
import { ClipboardImageUnavailable, clipboardObjectImage, isPortableRasterImage } from "../../lib/clipboard-image";
import { portableClipboardColor } from "./clipboard-color";
import { clipboardFormulaMarkdown, CLIPBOARD_LATEX, copyClipboardFormula, plainMath, RENDERED_MATH } from "./clipboard-math";
import { copyPlotImage, isPortablePlotImage } from "./clipboard-plot";

const MESSAGE_BODY = "[data-chat-message-copy-body]";
const MARKDOWN_ROOT = "[data-chat-markdown-scope]";
const ROOTS = MESSAGE_BODY + ", " + MARKDOWN_ROOT;
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const FORMULA_ATOM = RENDERED_MATH + ", [data-md-atomic='math'], button[data-clipboard-plot-equation]";
const CODE_BLOCK = "[data-streamdown='code-block']";
const CODE_BODY = "[data-streamdown='code-block-body']";
const CODE_HEADER = "[data-streamdown='code-block-header']";
const VISUAL_LABEL = "[data-clipboard-label], [data-clipboard-chart-legend] button";
export const RENDERED_MERMAID_SVG = "[data-streamdown='mermaid'] [role='img'] > svg";
export const CLIPBOARD_CODE_LABEL = "data-deeix-code-language";
const IGNORE = [
  "script, style, template, iframe, object, embed, svg, canvas, button, input, select, textarea",
  "[hidden], [aria-hidden='true'], .sr-only, [inert], [data-footnote-backref], [data-screenshot-exclude='true']",
  "[data-streamdown='code-block-actions'], [data-streamdown='table-download-actions']",
  "[data-markdown-mermaid-loading]",
].join(", ");
const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd",
  "li", "mark", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr",
]);
const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);
const STRUCTURAL_EMPTY_TAGS = new Set(["li", "td", "th"]);
const NUMERIC_ATTRIBUTES_BY_TAG: ReadonlyMap<string, readonly string[]> = new Map([
  ["ol", ["start"]],
  ["li", ["value"]],
  ["td", ["colspan", "rowspan"]],
  ["th", ["colspan", "rowspan"]],
  ["col", ["span"]],
  ["img", ["width", "height"]],
]);
const BLOCK_TAGS = new Set([
  "article", "aside", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5",
  "h6", "li", "p", "pre", "section",
]);
const CELL_STYLE = "border: 1px solid #cbd5e1; padding: 4px 8px; vertical-align: top;";
const PORTABLE_STYLE: Readonly<Record<string, string>> = {
  blockquote: "border-left: 3px solid #cbd5e1; margin-left: 0; padding-left: 1em;",
  pre: "white-space: pre-wrap; font-family: Consolas, monospace; background-color: #f3f4f6; color: #1f2328; padding: 0.6em 0.8em;",
  code: "font-family: Consolas, monospace;",
  table: "border-collapse: collapse;",
  td: CELL_STYLE,
  th: CELL_STYLE + " font-weight: bold; background-color: #f3f4f6; color: #1f2328;",
};
const COMPUTED_TEXT_STYLES = [
  "color", "font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "white-space",
];
const COMPUTED_SURFACE_STYLES = ["background-color", "border-radius", "text-decoration-line", "text-align"];
const INLINE_STYLES = [
  "background", "background-color", "border", "border-bottom", "border-left", "border-right", "border-top", "border-color",
  "border-radius", "border-style", "border-width", "border-collapse", "color", "display", "flex-direction", "flex-wrap",
  "font-family", "font-size", "font-style", "font-weight", "gap", "grid-template-columns", "height", "letter-spacing", "line-height",
  "margin", "margin-bottom", "margin-left", "margin-right", "margin-top", "margin-block", "margin-inline", "max-width", "padding",
  "padding-bottom", "padding-left", "padding-right", "padding-top", "padding-block", "padding-inline", "text-align", "text-decoration",
  "text-indent", "vertical-align", "white-space", "width",
];

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

function isElement(node: Node): node is Element { return node.nodeType === 1; }
function isHTMLElement(node: Node): node is HTMLElement { return isElement(node) && node.namespaceURI === HTML_NAMESPACE; }
function isHTMLTag<K extends keyof HTMLElementTagNameMap>(node: Element, tag: K): node is HTMLElementTagNameMap[K] {
  return node.namespaceURI === HTML_NAMESPACE && node.localName === tag;
}

function elementOf(node: Node): Element | null {
  return isElement(node) ? node : node.parentElement;
}

function copyRoot(node: Node): Element | null {
  const element = elementOf(node);
  return element?.closest(MESSAGE_BODY) ?? element?.closest(MARKDOWN_ROOT) ?? null;
}

function clipboardURL(source: string, base: string, image: boolean): string | undefined {
  if (!source.trim()) return;
  if (!image && source.startsWith("#")) return source;
  if (image && (isPortableRasterImage(source) || isPortablePlotImage(source))) return source;
  if (image && /^blob:/i.test(source)) return clipboardObjectImage(source);
  try {
    const url = new URL(source, base);
    if (!url.username && !url.password && (url.protocol === "http:" || url.protocol === "https:" ||
      (!image && (url.protocol === "mailto:" || url.protocol === "tel:")))) return url.href;
  } catch {
    return;
  }
}

function safeClipboardStyle(value: string): boolean {
  return Boolean(value) && !/(?:(?:url|var|expression|image(?:-set)?|cross-fade|element|paint|src)\s*\(|javascript:|@import|[\\<>{}])/i.test(value);
}

function copyStyles(source: HTMLElement, target: HTMLElement) {
  const tag = target.localName;
  const portable = PORTABLE_STYLE[tag];
  if (portable) target.style.cssText = portable;
  const view = source.ownerDocument.defaultView;
  const setStyle = (property: string, value: string) => {
    if (safeClipboardStyle(value)) target.style.setProperty(property, portableClipboardColor(value, source.ownerDocument));
  };
  const inlineCode = tag === "code" && source.parentElement?.localName !== "pre";
  if (inlineCode) {
    target.style.backgroundColor = "#f3f4f6";
    target.style.color = "#1f2328";
    target.style.whiteSpace = "pre-wrap";
  }
  if (source.classList.contains("whitespace-pre-wrap")) target.style.whiteSpace = "pre-wrap";

  // CSS classes and variables are local to the chat page. Export the resolved
  // styles that affect the content, not the page layout or interactive chrome.
  const computed = view?.getComputedStyle(source);
  const foreground = computed?.color;
  if (foreground && source.parentElement && foreground !== view?.getComputedStyle(source.parentElement).color) {
    setStyle("color", foreground);
  }
  const codeBody = tag === "pre" ? source.closest(CODE_BODY) : null;
  const surface = codeBody ? view?.getComputedStyle(codeBody) : computed;
  const whiteSpace = computed?.whiteSpace;
  if (whiteSpace && /^(?:pre|pre-wrap|break-spaces)$/.test(whiteSpace)) target.style.whiteSpace = whiteSpace;
  const keepTypography = inlineCode || tag === "pre" || tag === "code" || source.matches(CODE_HEADER);
  if (keepTypography) {
    for (const property of COMPUTED_TEXT_STYLES) {
      const value = computed?.getPropertyValue(property) ?? "";
      if (property === "white-space" && /^(?:normal|pre)$/.test(value)) continue;
      setStyle(property, value);
    }
  }
  for (const property of COMPUTED_SURFACE_STYLES) {
    const value = surface?.getPropertyValue(property) ?? "";
    if (/^(?:transparent|rgba\(0,\s*0,\s*0,\s*0\)|none|0px|start)$/.test(value)) continue;
    setStyle(property, value);
  }
  if (tag === "li" && computed?.listStyleType === "none") target.style.listStyleType = "none";
  for (const property of INLINE_STYLES) {
    let value = source.style.getPropertyValue(property);
    if (value.includes("var(")) value = computed?.getPropertyValue(property) ?? "";
    setStyle(property, value);
  }
  const code = source.closest(CODE_BODY);
  if (tag === "span" && code && source.style.getPropertyValue("--shiki-light")) {
    const themeColor = computed?.color ?? "";
    setStyle("color", themeColor);
  }
}

function copyAttributes(source: HTMLElement, target: HTMLElement) {
  const tag = target.localName;
  for (const name of ["dir", "lang", "title", "id"]) {
    const value = source.getAttribute(name);
    if (value && (name !== "id" || /^[\w:.-]+$/.test(value))) target.setAttribute(name, value);
  }
  const align = source.getAttribute("align");
  if (align && /^(left|center|right|justify)$/i.test(align)) target.setAttribute("align", align);
  if (tag === "a") {
    const href = clipboardURL(source.getAttribute("href") ?? "", source.baseURI, false);
    if (href) target.setAttribute("href", href);
  }
  if (tag === "code") {
    const languageClass = Array.from(source.classList).find((name) => /^language-[\w+#.-]+$/i.test(name));
    const blockLanguage = source.closest(CODE_BLOCK)?.getAttribute("data-language");
    if (languageClass) target.className = languageClass;
    else if (blockLanguage && /^[a-z0-9_+#.-]+$/i.test(blockLanguage)) target.className = "language-" + blockLanguage;
  }
  for (const name of NUMERIC_ATTRIBUTES_BY_TAG.get(tag) ?? []) {
    const value = source.getAttribute(name);
    if (value && /^-?\d+$/.test(value)) target.setAttribute(name, value);
  }
  if (tag === "ol" && source.hasAttribute("reversed")) target.setAttribute("reversed", "");
}

function directListItems(list: Element): Element[] {
  return Array.from(list.children).filter((child) => child.localName === "li");
}

function includesOpening(range: Range, element: Element): boolean {
  const parent = element.parentNode;
  if (!parent) return false;
  const opening = Array.from(parent.childNodes).indexOf(element);
  return range.comparePoint(parent, opening) === 0;
}

function selectedTableContents(table: HTMLTableElement, range: Range): HTMLElement | undefined {
  if (includesOpening(range, table)) return;
  const cells = Array.from(table.rows).flatMap((row) => Array.from(row.cells)).filter((cell) => range.intersectsNode(cell));
  const caption = table.caption;
  if (caption && range.intersectsNode(caption)) return cells.length ? undefined : caption;
  if (cells.length === 1 && !includesOpening(range, cells[0])) return cells[0];
}

function copyList(source: Element, list: HTMLElement, owner: Document, range?: Range): Node | undefined {
  const fragment = owner.createDocumentFragment();
  const numbers = range && isHTMLTag(source, "ol") ? orderedItemNumbers(source) : undefined;
  let previousNumber: number | undefined;
  for (const item of directListItems(source)) {
    if (range && !range.intersectsNode(item)) continue;
    const keepMarker = !range || includesOpening(range, item);
    const content = copyBranch(item, owner, range, keepMarker ? undefined : "div");
    if (!content) continue;
    if (!keepMarker) {
      fragment.append(content);
      continue;
    }
    const number = numbers?.get(item);
    // A clipped list can start midway through the source sequence. Keep the
    // source number even when an unselected item or a value override intervenes.
    if (!list.parentNode) {
      if (number !== undefined) list.setAttribute("start", String(number));
      fragment.append(list);
    } else if (number !== undefined && previousNumber !== undefined &&
      number !== previousNumber + (source.hasAttribute("reversed") ? -1 : 1) && isElement(content)) {
      content.setAttribute("value", String(number));
    }
    previousNumber = number;
    list.append(content);
  }
  return fragment.hasChildNodes() ? fragment : undefined;
}

function orderedItemNumbers(list: Element): Map<Element, number> {
  const items = directListItems(list);
  const reversed = list.hasAttribute("reversed");
  const step = reversed ? -1 : 1;
  const defaultStart = reversed ? items.length : 1;
  let next = list.hasAttribute("start") ? Number(list.getAttribute("start")) : defaultStart;
  const numbers = new Map<Element, number>();
  for (const item of items) {
    const current = item.hasAttribute("value") ? Number(item.getAttribute("value")) : next;
    numbers.set(item, current);
    next = current + step;
  }
  return numbers;
}

type ClipboardPresentationTag = "div" | "span";

function copyBranch(source: Node, owner: Document, range?: Range, presentationTag?: ClipboardPresentationTag): Node | undefined {
  if (range && !range.intersectsNode(source)) return;
  if (source.nodeType === 3) {
    const text = (source.nodeValue ?? "").slice(
      range?.startContainer === source ? range.startOffset : 0,
      range?.endContainer === source ? range.endOffset : undefined,
    );
    return text ? owner.createTextNode(text) : undefined;
  }
  if (!isElement(source)) return;
  if (isHTMLElement(source) && (source.style.display === "none" || source.style.visibility === "hidden")) return;
  if (isHTMLTag(source, "input") && source.type === "checkbox" && source.disabled && source.parentElement?.closest("li")) {
    return owner.createTextNode(source.checked ? "☑ " : "☐ ");
  }
  const isMermaid = source.matches(RENDERED_MERMAID_SVG);
  if (isMermaid || source.matches("svg[data-clipboard-plot], [data-clipboard-chart] svg.recharts-surface")) {
    const image = copyPlotImage(source, owner, isMermaid);
    if (!image) throw new Error("The selected graph is not ready to copy");
    return image;
  }
  if (source.matches("[data-clipboard-plot-equation]")) {
    if (isHTMLTag(source, "button")) return copyClipboardFormula(source, owner);
    if (isHTMLTag(source, "input")) return source.value.trim() ? owner.createTextNode(source.value) : undefined;
  }
  const visualLabel = source.matches(VISUAL_LABEL);
  if (!visualLabel && source.matches(IGNORE)) return;
  if (source.matches("[data-clipboard-chart]:not(:has(svg.recharts-surface))") ||
    (source.hasAttribute("data-markdown-mermaid") && !source.querySelector(RENDERED_MERMAID_SVG + ", [data-markdown-mermaid-error], " + CODE_BLOCK))) {
    throw new Error("The selected graph is not ready to copy");
  }
  if (source.hasAttribute("data-clipboard-image-unavailable")) throw new ClipboardImageUnavailable();
  if (source.matches(RENDERED_MATH)) return copyClipboardFormula(source, owner);
  if (!isHTMLElement(source)) return;

  const element = source;
  const tag = element.localName;
  if (element.matches(CODE_BLOCK)) {
    const pre = element.querySelector(CODE_BODY + " pre");
    if (pre) {
      // Keep the label separate from the code, and only if the range reaches it.
      const wrapper = owner.createDocumentFragment();
      for (const part of [element.querySelector(CODE_HEADER), pre]) {
        const copy = part && copyBranch(part, owner, range);
        if (copy) wrapper.append(copy);
      }
      return wrapper.hasChildNodes() ? wrapper : undefined;
    }
  }
  if (range && isHTMLTag(element, "table")) {
    const item = selectedTableContents(element, range);
    if (item) return copyBranch(item, owner, range, "div");
  }
  const transparent = element.matches(ROOTS + ", [data-md-copy-scope], [data-md-text]");
  const outputTag = presentationTag ?? (visualLabel || (range && tag === "blockquote" && !includesOpening(range, element)) ? "div" : tag);
  const target = HTML_TAGS.has(outputTag) && !transparent ? owner.createElement(outputTag) : undefined;
  const output = target ?? owner.createDocumentFragment();
  if (target) {
    if (isHTMLTag(element, "img")) {
      const alt = element.alt;
      const src = clipboardURL(element.currentSrc || element.getAttribute("src") || "", element.baseURI, true);
      if (!src) throw new ClipboardImageUnavailable();
      target.setAttribute("src", src);
      target.setAttribute("alt", alt);
    }
    copyStyles(element, target);
    copyAttributes(element, target);
    if (VOID_TAGS.has(tag)) return target;
    if (tag === "ol" || tag === "ul") return copyList(element, target, owner, range);
    if (element.matches(CODE_HEADER)) target.setAttribute(CLIPBOARD_CODE_LABEL, "");
  }

  const codeLines = tag === "code" && element.parentElement?.localName === "pre" && element.closest(CODE_BODY)
    ? Array.from(element.children) : [];
  if (codeLines.length && codeLines.every((line) => line.localName === "span")) {
    // Streamdown lays individual lines out with CSS, not literal line breaks.
    // Restore the breaks without bringing along its generated line numbers.
    let firstLine = true;
    for (const line of codeLines) {
      if (range && !range.intersectsNode(line)) continue;
      if (!firstLine) output.appendChild(owner.createTextNode("\n"));
      firstLine = false;
      if (line.textContent === "\n") continue;
      const child = copyBranch(line, owner, range);
      if (child) output.appendChild(child);
    }
  } else {
    for (const child of element.childNodes) {
      if (tag === "details" && !element.hasAttribute("open") && elementOf(child)?.localName !== "summary") continue;
      const copy = copyBranch(child, owner, range);
      if (copy) output.appendChild(copy);
    }
  }
  // An empty cell still occupies a column, and an empty item still occupies
  // a list number. Keep them only when their structure was selected.
  if (output.hasChildNodes() || (target && STRUCTURAL_EMPTY_TAGS.has(outputTag) && (!range || includesOpening(range, element)))) {
    return output;
  }
}

function plainText(root: Node, listIndent = 0): string {
  let output = "";
  let pendingBreak = 0;
  function add(value: string) {
    if (!value) return;
    if (pendingBreak) {
      if (output) output += "\n".repeat(Math.max(0, pendingBreak - (output.match(/\n+$/)?.[0].length ?? 0)));
      pendingBreak = 0;
    }
    output += value;
  }
  function separate(lines: number) { pendingBreak = Math.max(pendingBreak, lines); }
  function visit(node: Node, preserveWhitespace = false) {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      if (!preserveWhitespace && !value.trim() && (pendingBreak || (!output && value.includes("\n")))) return;
      add(preserveWhitespace ? value : value.replace(/[\t\r\n\f ]+/g, " "));
      return;
    }
    if (!isElement(node)) return;
    const element = node;
    const tag = element.localName;
    if (tag === "br") { add("\n"); return; }
    if (tag === "hr") { separate(2); return; }
    if (tag === "img") { add(element.getAttribute("alt") ?? ""); return; }
    const latex = clipboardFormulaMarkdown(element);
    if (latex) {
      const display = tag === "div";
      if (display) separate(2);
      add(latex);
      if (display) separate(2);
      return;
    }
    if (tag === "math") {
      const display = element.getAttribute("display") === "block";
      if (display) separate(2);
      add(plainMath(element));
      if (display) separate(2);
      return;
    }
    if (isHTMLTag(element, "table")) {
      separate(2);
      const table = element;
      if (table.caption) add(plainText(table.caption) + "\n");
      add(Array.from(table.rows, (row) => Array.from(row.cells, (cell) => plainText(cell).replace(/\n+/g, " ")).join("\t")).join("\n"));
      separate(2);
      return;
    }
    if (tag === "ol" || tag === "ul") {
      separate(2);
      const numbers = tag === "ol" ? orderedItemNumbers(element) : undefined;
      const indent = " ".repeat(listIndent);
      for (const item of directListItems(element)) {
        const hiddenMarker = isHTMLElement(item) && item.style.listStyleType === "none";
        const marker = hiddenMarker ? "" : numbers ? String(numbers.get(item)) + ". " : "• ";
        // Indent nested list markers without shifting the contents of a code block.
        add(indent + marker + plainText(item, listIndent + Math.max(marker.length, 2)));
        separate(1);
      }
      separate(2);
      return;
    }
    if (BLOCK_TAGS.has(tag)) separate(2);
    const preserve = preserveWhitespace || tag === "pre" || tag === "code" ||
      (isHTMLElement(element) && /^(?:pre|pre-wrap|break-spaces)$/.test(element.style.whiteSpace));
    for (const child of element.childNodes) visit(child, preserve);
    if (BLOCK_TAGS.has(tag)) separate(2);
  }
  for (const child of root.childNodes) visit(child);
  return output;
}

function containsOnlyClipboardFormula(node: Element): boolean {
  if (node.hasAttribute(CLIPBOARD_LATEX)) return true;
  if (node.localName !== "div" && node.localName !== "span") return false;
  const children = Array.from(node.childNodes).filter((child) => isElement(child) || child.textContent?.trim());
  const [child] = children;
  return children.length === 1 && isElement(child) && containsOnlyClipboardFormula(child);
}

function serializeRoots(roots: Element[], range?: Range, presentationTag?: ClipboardPresentationTag): RichClipboardContent | undefined {
  if (!roots.length) return;
  // Make an inert fragment rather than inserting message content into the page.
  const owner = roots[0].ownerDocument.implementation.createHTMLDocument("");
  const fragment = owner.createElement("div");
  for (const root of roots) {
    const node = copyBranch(root, owner, range, presentationTag);
    if (!node) continue;
    if (roots.length > 1) {
      const section = owner.createElement("div");
      section.appendChild(node);
      fragment.appendChild(section);
    } else fragment.appendChild(node);
  }
  if (!fragment.hasChildNodes()) return;
  const text = plainText(fragment);
  // When copying just a formula, let note editors ingest Markdown directly
  // rather than asking their HTML importer to interpret dollar delimiters.
  if (containsOnlyClipboardFormula(fragment)) return { text };
  return { html: fragment.innerHTML, text };
}

export function renderedRichClipboard(root: Element): RichClipboardContent | undefined {
  return serializeRoots([root]);
}

export function renderedCodeClipboard(pre: HTMLPreElement, text: string): RichClipboardContent | undefined {
  const owner = pre.ownerDocument.implementation.createHTMLDocument("");
  const fragment = copyBranch(pre, owner);
  if (!fragment || !isElement(fragment) || !isHTMLTag(fragment, "pre")) return;
  const code = fragment.querySelector("code");
  if (!code) return;

  // Streamdown's fallback drops trailing newlines. Add them after the styled
  // tokens, or use the exact source if the renderer changed other characters.
  const rendered = code.textContent ?? "";
  if (text !== rendered) {
    const tail = text.slice(rendered.length);
    if (text.startsWith(rendered) && /^\n+$/.test(tail)) code.append(tail);
    else code.textContent = text;
  }
  return { html: fragment.outerHTML, text };
}

export function selectionRichClipboard(selection: Selection, owner: Document): RichClipboardContent | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if ([range.startContainer, range.endContainer].some((node) => {
    const element = elementOf(node);
    const button = element?.closest("button");
    return element?.closest(EDITABLE) || (button && !button.matches("[data-clipboard-plot-equation]"));
  })) return;
  const start = copyRoot(range.startContainer);
  const end = copyRoot(range.endContainer);
  // Leave native selections outside chat content (including attachment labels) alone.
  if (!start || !end) return;
  const startElement = elementOf(range.startContainer);
  const pre = startElement?.closest("pre");
  if (pre?.contains(range.endContainer)) return serializeRoots([pre], range);
  const code = startElement?.closest("code");
  // Only bypass ancestors for standalone code. Otherwise keep enclosing
  // inline formatting, such as a link whose label happens to be code.
  if (code?.contains(range.endContainer) && code.parentElement?.matches("p, li, td, th")) {
    return serializeRoots([code], range);
  }

  // Text selected within one paragraph is inline content, including when
  // the paragraph sits inside a list, a table cell, or a quote.
  const paragraph = startElement?.closest("p");
  if (paragraph?.contains(range.endContainer) && !includesOpening(range, paragraph)) {
    return serializeRoots([paragraph], range, "span");
  }
  const roots = start === end ? [start] : Array.from(owner.querySelectorAll(ROOTS)).filter((root) => copyRoot(root) === root && range.intersectsNode(root));
  return serializeRoots(roots, range);
}

function formulaBoundary(container: Node, offset: number, end: boolean): readonly [Node, number] {
  const element = elementOf(container);
  const scope = element?.closest(MARKDOWN_ROOT);
  if (!scope || element?.closest(EDITABLE + ", pre, code")) return [container, offset];
  let atom = element?.closest(FORMULA_ATOM);
  if (!atom || !scope.contains(atom)) return [container, offset];
  // KaTeX nests its MathML and visual markup. Snap to the outermost wrapper.
  for (let outer = atom.parentElement?.closest(FORMULA_ATOM); outer && scope.contains(outer); outer = atom.parentElement?.closest(FORMULA_ATOM)) {
    atom = outer;
  }
  const parent = atom.parentNode;
  if (!parent) return [container, offset];
  const index = Array.from(parent.childNodes).indexOf(atom);
  return [parent, end ? index + 1 : index];
}

function keepFormulaSelectionAtomic(selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const range = selection.getRangeAt(0);
  const { startContainer, startOffset, endContainer, endOffset } = range;
  const start = formulaBoundary(startContainer, startOffset, false);
  const end = formulaBoundary(endContainer, endOffset, true);
  if (start[0] === startContainer && start[1] === startOffset && end[0] === endContainer && end[1] === endOffset) return;
  const backward = selection.anchorNode === endContainer && selection.anchorOffset === endOffset;
  // Move the live selection, not just the text exported by the copy event.
  selection.setBaseAndExtent(...(backward ? end : start), ...(backward ? start : end));
}

type CopyRegistration = { onError?: (error: unknown) => void };
const listeners = new WeakMap<Document, {
  users: Set<CopyRegistration>;
  onCopy: (event: ClipboardEvent) => void;
  onSelectionChange: () => void;
}>();

export function listenForRichSelectionCopy(owner: Document, onError?: CopyRegistration["onError"]) {
  let listener = listeners.get(owner);
  if (!listener) {
    const users = new Set<CopyRegistration>();
    listener = { users, onSelectionChange: () => keepFormulaSelectionAtomic(owner.getSelection()), onCopy: (event) => {
      if (event.defaultPrevented || !event.clipboardData || owner.activeElement?.closest(EDITABLE)) return;
      try {
        const selection = owner.getSelection();
        const content = selection && selectionRichClipboard(selection, owner);
        if (!content) return;
        setRichClipboardData(event.clipboardData, content);
        event.preventDefault();
      } catch (error) {
        // A missing image must not silently fall through to a broken URL or alt text.
        event.preventDefault();
        for (const registration of users) {
          if (!registration.onError) continue;
          registration.onError(error);
          break;
        }
      }
    } };
    listeners.set(owner, listener);
    owner.addEventListener("copy", listener.onCopy);
    owner.addEventListener("selectionchange", listener.onSelectionChange);
  }
  const current = listener;
  const registration = { onError };
  current.users.add(registration);
  return () => {
    current.users.delete(registration);
    if (current.users.size) return;
    owner.removeEventListener("copy", current.onCopy);
    owner.removeEventListener("selectionchange", current.onSelectionChange);
    listeners.delete(owner);
  };
}
