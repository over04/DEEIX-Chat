import { type RichClipboardContent, setRichClipboardData } from "../../lib/clipboard";
import { ClipboardImageUnavailable, clipboardObjectImage, isPortableRasterImage } from "../../lib/clipboard-image";
import { copyMath, plainMath, RENDERED_MATH } from "./clipboard-math";
import { copyPlotImage } from "./clipboard-plot";

const MESSAGE_BODY = "[data-chat-message-copy-body]";
const MARKDOWN_ROOT = "[data-chat-markdown-scope]";
const ROOTS = MESSAGE_BODY + ", " + MARKDOWN_ROOT;
const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
const CODE_BODY = "[data-streamdown='code-block-body']";
const IGNORE = [
  "script, style, template, iframe, object, embed, svg, canvas, button, input, select, textarea",
  "[hidden], [aria-hidden='true'], .sr-only, [inert], [data-footnote-backref], [data-screenshot-exclude='true']",
  "[data-streamdown='code-block-header'], [data-streamdown='code-block-actions'], [data-streamdown='table-download-actions']",
  "[data-markdown-mermaid-loading]",
].join(", ");
const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd",
  "li", "mark", "ol", "p", "pre", "q", "s", "samp", "section", "small", "span", "strong", "sub", "sup", "table", "tbody",
  "td", "tfoot", "th", "thead", "tr", "u", "ul", "var", "wbr",
]);
const VOID_TAGS = new Set(["br", "col", "hr", "img", "wbr"]);
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
  if (image && isPortableRasterImage(source)) return source;
  if (image && /^blob:/i.test(source)) return clipboardObjectImage(source);
  try {
    const url = new URL(source, base);
    if (!url.username && !url.password && (url.protocol === "http:" || url.protocol === "https:" ||
      (!image && (url.protocol === "mailto:" || url.protocol === "tel:")))) return url.href;
  } catch {
    return;
  }
}

function copyStyles(source: HTMLElement, target: HTMLElement) {
  const tag = target.localName;
  const portable = PORTABLE_STYLE[tag];
  if (portable) target.style.cssText = portable;
  if (tag === "code" && source.parentElement?.localName !== "pre") {
    target.style.backgroundColor = "#f3f4f6";
    target.style.color = "#1f2328";
  }
  if (source.classList.contains("whitespace-pre-wrap")) target.style.whiteSpace = "pre-wrap";
  if (!source.hasAttribute("style")) return;
  let computed: CSSStyleDeclaration | undefined;
  for (const property of INLINE_STYLES) {
    let value = source.style.getPropertyValue(property);
    if (!value) continue;
    if (value.includes("var(")) {
      computed ??= source.ownerDocument.defaultView?.getComputedStyle(source);
      value = computed?.getPropertyValue(property) ?? "";
    }
    if (value && !/(?:url\s*\(|expression\s*\(|var\s*\(|javascript:|[\\<>{}])/i.test(value)) {
      target.style.setProperty(property, value);
    }
  }
  const codeColor = source.style.getPropertyValue("--shiki-light").trim();
  if (source.closest(CODE_BODY) && /^#[0-9a-f]{3,8}$/i.test(codeColor)) target.style.color = codeColor;
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
    const language = Array.from(source.classList).find((name) => /^language-[\w+#.-]+$/i.test(name));
    if (language) target.className = language;
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

function copyBranch(source: Node, owner: Document, range?: Range): Node | undefined {
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
  if (source.matches("svg[data-clipboard-plot]")) return copyPlotImage(source, owner);
  if (source.matches("[data-clipboard-plot-equation]")) {
    if (isHTMLTag(source, "button")) return copyMath(source, owner);
    if (isHTMLTag(source, "input")) return source.value.trim() ? owner.createTextNode(source.value) : undefined;
  }
  if (source.matches(IGNORE)) return;
  if (source.hasAttribute("data-clipboard-image-unavailable")) throw new ClipboardImageUnavailable();
  if (source.matches(RENDERED_MATH)) return copyMath(source, owner);
  if (!isHTMLElement(source)) return;

  const element = source;
  const tag = element.localName;
  const transparent = element.matches(ROOTS + ", [data-md-copy-scope], [data-md-text]");
  const target = HTML_TAGS.has(tag) && !transparent ? owner.createElement(tag) : undefined;
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
    const itemNumbers = range && tag === "ol" ? orderedItemNumbers(element) : undefined;
    let keptFirstItem = false;
    for (const child of element.childNodes) {
      if (tag === "details" && !element.hasAttribute("open") && elementOf(child)?.localName !== "summary") continue;
      const copy = copyBranch(child, owner, range);
      if (!copy) continue;
      if (itemNumbers && target && !keptFirstItem && isElement(child) && itemNumbers.has(child)) {
        target.setAttribute("start", String(itemNumbers.get(child)));
        keptFirstItem = true;
      }
      output.appendChild(copy);
    }
  }
  return output.hasChildNodes() ? output : undefined;
}

function plainText(root: Node): string {
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
      if (!preserveWhitespace && pendingBreak && !value.trim()) return;
      add(preserveWhitespace ? value : value.replace(/[\t\r\n\f ]+/g, " "));
      return;
    }
    if (!isElement(node)) return;
    const element = node;
    const tag = element.localName;
    if (tag === "br") { add("\n"); return; }
    if (tag === "hr") { separate(2); return; }
    if (tag === "img") { add(element.getAttribute("alt") ?? ""); return; }
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
      for (const item of directListItems(element)) {
        const marker = numbers ? String(numbers.get(item)) + ". " : "• ";
        add(marker + plainText(item).replace(/\n(?!\n)/g, "\n" + " ".repeat(marker.length)));
        separate(1);
      }
      separate(2);
      return;
    }
    if (BLOCK_TAGS.has(tag)) separate(2);
    const preserve = preserveWhitespace || tag === "pre" || (isHTMLElement(element) && element.style.whiteSpace === "pre-wrap");
    for (const child of element.childNodes) visit(child, preserve);
    if (BLOCK_TAGS.has(tag)) separate(2);
  }
  for (const child of root.childNodes) visit(child);
  return output;
}

function serializeRoots(roots: Element[], range?: Range): RichClipboardContent | undefined {
  if (!roots.length) return;
  // Make an inert fragment rather than inserting message content into the page.
  const owner = roots[0].ownerDocument.implementation.createHTMLDocument("");
  const fragment = owner.createElement("div");
  for (const root of roots) {
    const node = copyBranch(root, owner, range);
    if (!node) continue;
    if (roots.length > 1) {
      const section = owner.createElement("div");
      section.appendChild(node);
      fragment.appendChild(section);
    } else fragment.appendChild(node);
  }
  if (!fragment.hasChildNodes()) return;
  return { html: fragment.innerHTML, text: plainText(fragment) };
}

export function renderedRichClipboard(root: Element): RichClipboardContent | undefined {
  return serializeRoots([root]);
}

export function selectionRichClipboard(selection: Selection, owner: Document): RichClipboardContent | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if ([range.startContainer, range.endContainer].some((node) => elementOf(node)?.closest(EDITABLE + ", button"))) return;
  const start = copyRoot(range.startContainer);
  const end = copyRoot(range.endContainer);
  // Leave native selections outside chat content (including attachment labels) alone.
  if (!start || !end) return;
  const roots = start === end ? [start] : Array.from(owner.querySelectorAll(ROOTS)).filter((root) => copyRoot(root) === root && range.intersectsNode(root));
  return serializeRoots(roots, range);
}

type CopyRegistration = { onError?: (error: unknown) => void };
const listeners = new WeakMap<Document, { users: Set<CopyRegistration>; onCopy: (event: ClipboardEvent) => void }>();

export function listenForRichSelectionCopy(owner: Document, onError?: CopyRegistration["onError"]) {
  let listener = listeners.get(owner);
  if (!listener) {
    const users = new Set<CopyRegistration>();
    listener = { users, onCopy: (event) => {
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
  }
  const current = listener;
  const registration = { onError };
  current.users.add(registration);
  return () => {
    current.users.delete(registration);
    if (current.users.size) return;
    owner.removeEventListener("copy", current.onCopy);
    listeners.delete(owner);
  };
}
