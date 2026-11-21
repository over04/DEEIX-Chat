import type { StreamdownProps } from "streamdown";

import type { BoundaryBias } from "./markdown-source";

export type SourcePoint = { line: number; column: number; offset?: number };
export type SourcePosition = { start: SourcePoint; end: SourcePoint };

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string };
  position?: SourcePosition;
};

type MarkdownParser = { parse: (source: string) => MarkdownNode };
type RemarkPlugin = Extract<NonNullable<StreamdownProps["remarkPlugins"]>[number], (...args: never[]) => unknown>;

// Scan markup and Markdown literals together: a closing tag inside code is not a
// container boundary. Container-relative fences can start beyond column three.
// Each repeated quote prefix ends at `>`, giving spaces one owner.
const MIXED_TOKEN = /^((?:[ \t]*>)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(\x60{3,}|~{3,})([^\r\n]*)|(\x60+)|<!--[\s\S]*?(?:-->|(?![\s\S]))|<(\/?)([A-Za-z][\w:.-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gm;
const HTML_LITERAL = new Set(["code", "pre", "kbd", "samp", "script", "style", "textarea", "template", "iframe", "noscript", "title", "svg", "math", "plaintext", "xmp", "noembed", "noframes"]);
const HTML_CODE = new Set(["code", "pre", "kbd", "samp"]);
const HTML_RAW_BLOCK = new Set(["pre", "script", "style", "textarea"]);
const HTML_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_PHRASING = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "del", "em", "i", "ins", "kbd", "label", "mark", "p", "q", "s", "small", "span", "strong", "sub", "summary", "sup", "u", "var", "h1", "h2", "h3", "h4", "h5", "h6"]);
const HTML_BLOCK = new Set(["article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "header", "li", "main", "nav", "ol", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);

export function getLiteralMarkupRanges(source: string): Span[] {
  if (!source.includes("<") && !(source.includes("\x60") && /[\r\n]/.test(source))) return [];
  return scanMarkup(source).literals.filter(({ kind }) => kind !== "fence");
}

export function transformOutsideLiteralMarkup(source: string, transform: (part: string) => string): string {
  let at = 0;
  const parts: string[] = [];
  for (const { start, end } of getLiteralMarkupRanges(source)) {
    parts.push(transform(source.slice(at, start)), source.slice(start, end));
    at = end;
  }
  return parts.join("") + transform(source.slice(at));
}

function createPositionLookup(source: string) {
  const lines = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) lines.push(index + 1);
  const point = (offset: number): SourcePoint => {
    let lo = 0;
    let hi = lines.length;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (lines[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return { offset, line: lo + 1, column: offset - lines[lo] + 1 };
  };
  return (start: number, end: number): SourcePosition => ({ start: point(start), end: point(end) });
}

const FLOW_PREFIX = /^(?:[ \t]{0,3}>(?:[ \t]{0,4}>)*[ \t]?)?[ \t]{0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?$/;
const BLANK_LINE = /^([ \t]*(?:>[ \t]*)*)\r?$/gm;
const BLANK_MARKER_PREFIX = "<?deeix-md-blank:";
const PARAGRAPH_BREAK = /\r?\n[ \t]*(?:>[ \t]*)*\r?\n/;

function createBlankMarker(id: number) {
  const markerPattern = String.raw`<\?deeix-md-blank:${id}:(\d+)\?>`;
  return {
    prefix: BLANK_MARKER_PREFIX + id + ":",
    line: new RegExp(String.raw`^([ \t]*(?:>[ \t]*)*)${markerPattern}[ \t]*(?=\r?$)`, "gm"),
    paragraphBreak: new RegExp(String.raw`\r?\n[ \t]*(?:>[ \t]*)*(?:${markerPattern})?\r?\n`),
  };
}
const MAX_MARKUP_DEPTH = 32;
const HTML_LITERAL_TEXT = "deeixHtmlLiteralText";
const MARKUP_PARAGRAPH = "deeix-markup-paragraph";

// The default mdast text handler trims whitespace around line breaks. An HTML
// code element is verbatim text, so pass its value through to HAST unchanged.
type RehypeOptions = NonNullable<StreamdownProps["remarkRehypeOptions"]>;
type RehypeHandlers = NonNullable<RehypeOptions["handlers"]>;
const markupHandlers: RehypeHandlers & Record<typeof HTML_LITERAL_TEXT, NonNullable<RehypeHandlers["text"]>> = {
  [HTML_LITERAL_TEXT]: (_state, node) => ({
    type: "text",
    value: "value" in node && typeof node.value === "string" ? node.value : "",
    position: node.position,
  }),
};
export const MARKUP_REHYPE_OPTIONS: RehypeOptions = { handlers: markupHandlers };

type MarkupHastNode = { type?: string; tagName?: string; children?: MarkupHastNode[] };

// Restore paragraphs before raw HTML assembles their real parent. The temporary
// tag prevents remark-rehype from flattening them as direct tight-list children.
export function rehypeRestoreMarkupParagraphs() {
  return function visit(node: MarkupHastNode) {
    if (node.type === "element" && node.tagName === MARKUP_PARAGRAPH) node.tagName = "p";
    for (const child of node.children ?? []) visit(child);
  };
}

type Span = { start: number; end: number };
type Edit = Span & { text: string };
type MarkupToken = Span & { name?: string; closing: boolean; empty: boolean; pair?: MarkupToken };
type Literal = Span & { kind: "html" | "fence" | "inline-code" };
type SourceView = { text: string; offset: (index: number, bias: BoundaryBias) => number | undefined };

function linePrefix(source: string, index: number): string {
  return source.slice(source.lastIndexOf("\n", index - 1) + 1, index);
}

function endsLine(source: string, index: number): boolean {
  const end = source.indexOf("\n", index);
  return !source.slice(index, end === -1 ? undefined : end).trim();
}

function startsFlow(source: string, tag: MarkupToken): boolean {
  return !!tag.name && !tag.closing && !tag.empty && FLOW_PREFIX.test(linePrefix(source, tag.start)) &&
    (HTML_BLOCK.has(tag.name) || endsLine(source, tag.end) || /^(?:p|h[1-6])$/.test(tag.name));
}

function isEscaped(source: string, index: number): boolean {
  let before = index;
  while (before > 0 && source[before - 1] === "\\") before--;
  return (index - before) % 2 !== 0;
}

// A raw HTML block can interrupt a paragraph even when there is no blank
// line before it. A backtick on either side cannot form one code span.
function interruptsCodeSpan(text: string, paragraphBreak: RegExp): boolean {
  if (paragraphBreak.test(text)) return true;
  for (const [, name] of text.matchAll(/\n(?:[ \t]{0,3}>(?:[ \t]{0,4}>)*[ \t]?)?[ \t]{0,3}<(?:\/?([A-Za-z][\w-]*)(?=[\s/>])|[!?])/g)) {
    const tag = name?.toLowerCase();
    if (!tag || HTML_BLOCK.has(tag) || HTML_RAW_BLOCK.has(tag) || /^(?:hr|p|h[1-6])$/.test(tag)) return true;
  }
  return false;
}

function closingBackticks(source: string, from: number, length: number, paragraphBreak: RegExp): number | undefined {
  const pattern = /\x60+/g;
  pattern.lastIndex = from;
  let previous = from;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (interruptsCodeSpan(source.slice(previous, match.index), paragraphBreak)) break;
    if (match[0].length === length) return pattern.lastIndex;
    previous = pattern.lastIndex;
  }
}

type MarkdownContainer = { quotes: number; listIndent: number };

function markdownContainer(prefix: string) {
  const quotePrefix = /^(?:[ \t]*>)+[ \t]?/.exec(prefix)?.[0] ?? "";
  const local = prefix.slice(quotePrefix.length);
  const quotes = (quotePrefix.match(/>/g) ?? []).length;
  const listIndent = /\S/.test(local) ? indentColumns(local) : 0;
  return { quotes, listIndent, local };
}

function containerContent(line: string, { quotes, listIndent }: MarkdownContainer): string | undefined {
  let at = 0;
  for (let quote = 0; quote < quotes; quote++) {
    while (line[at] === " " || line[at] === "\t") at++;
    if (line[at] !== ">") return;
    at++;
    if (line[at] === " " || line[at] === "\t") at++;
  }
  const content = line.slice(at);
  if (listIndent && content.trim() && indentColumns(/^[ \t]*/.exec(content)?.[0] ?? "") < listIndent) return;
  return content;
}

function endOfMarkdownContainer(source: string, from: number, end: number, container: MarkdownContainer): number {
  if (!container.quotes && !container.listIndent) return end;
  for (let newline = source.indexOf("\n", from); newline >= 0 && newline + 1 < end;) {
    const start = newline + 1;
    newline = source.indexOf("\n", start);
    if (containerContent(source.slice(start, newline < 0 ? undefined : newline), container) == null) return start;
  }
  return end;
}

// A fence is closed by its Markdown container ending as well as by a closing
// marker. Stop at that line so following HTML can still be scanned normally.
function findFenceEnd(source: string, from: number, prefix: string, marker: string, inMarkup: boolean): number {
  const container = markdownContainer(prefix);
  const maxIndent = (container.listIndent || (inMarkup ? indentColumns(container.local) : 0)) + 3;
  let newline = source.indexOf("\n", from);
  while (newline >= 0) {
    const start = newline + 1;
    newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline;
    const line = containerContent(source.slice(start, end), container);
    if (line == null) return start;
    const indentation = indentColumns(/^[ \t]*/.exec(line)?.[0] ?? "");
    const closing = /^[ \t]*(\x60{3,}|~{3,})[ \t]*\r?$/.exec(line)?.[1];
    if (closing && indentation <= maxIndent && closing[0] === marker[0] && closing.length >= marker.length) return end;
  }
  return source.length;
}

function scanMarkup(source: string, insideMarkup = false, paragraphBreak = PARAGRAPH_BREAK): { tags: MarkupToken[]; literals: Literal[] } {
  const pattern = new RegExp(MIXED_TOKEN.source, MIXED_TOKEN.flags);
  const tags: MarkupToken[] = [];
  const literals: Literal[] = [];
  const open: MarkupToken[] = [];
  for (let token = pattern.exec(source); token; token = pattern.exec(source)) {
    const [, prefix, marker, info, ticks, close, rawName] = token;
    const start = token.index;
    const end = pattern.lastIndex;
    if (marker) {
      const inMarkup = insideMarkup || open.some((tag) => startsFlow(source, tag));
      if ((inMarkup || FLOW_PREFIX.test(prefix)) && (marker[0] === "~" || !info.includes("\x60"))) {
        const fenceEnd = findFenceEnd(source, end, prefix, marker, inMarkup);
        literals.push({ start, end: fenceEnd, kind: "fence" });
        pattern.lastIndex = fenceEnd;
      }
      continue;
    }
    if (isEscaped(source, start)) continue;
    if (ticks) {
      const closing = closingBackticks(source, end, ticks.length, paragraphBreak);
      if (closing != null) {
        // The text normalizers already skip single-line code spans. Keep the
        // whole multiline span out of normalization as well.
        if (/[\r\n]/.test(source.slice(end, closing))) literals.push({ start, end: closing, kind: "inline-code" });
        pattern.lastIndex = closing;
      }
      continue;
    }
    const name = rawName?.toLowerCase();
    const tag: MarkupToken = { name, start, end, closing: !!close, empty: !name || HTML_VOID.has(name) || /\/\s*>$/.test(token[0]) };
    tags.push(tag);
    if (!name || tag.empty) continue;
    if (tag.closing) {
      const opener = open.findLastIndex((entry) => entry.name === name);
      if (opener >= 0) {
        open[opener].pair = tag;
        open.length = opener;
      }
    } else if (HTML_LITERAL.has(name)) {
      const prefix = linePrefix(source, start);
      const atFlow = FLOW_PREFIX.test(prefix) || (!prefix.trim() &&
        (insideMarkup || open.some((wrapper) => startsFlow(source, wrapper))));
      const inlineCode = HTML_CODE.has(name) && name !== "pre";
      const isBlock = atFlow && (!inlineCode || endsLine(source, end));
      const closing = new RegExp("</" + name + "\\s*>", "gi");
      closing.lastIndex = end;
      const match = closing.exec(source);
      if (match) {
        // A closing tag in a later paragraph does not belong to an inline literal.
        if (!isBlock && paragraphBreak.test(source.slice(end, match.index))) continue;
        const pair = { name, start: match.index, end: closing.lastIndex, closing: true, empty: false };
        tag.pair = pair;
        tags.push(pair);
      } else if (!isBlock || !HTML_RAW_BLOCK.has(name)) {
        // Only an open raw HTML block stays literal to the end of the input.
        continue;
      }
      pattern.lastIndex = match ? closing.lastIndex : source.length;
      literals.push({ start, end: pattern.lastIndex, kind: "html" });
    } else {
      open.push(tag);
    }
  }
  return { tags, literals };
}

// CommonMark ends an HTML block at a blank line, including a blank in a
// descendant's Markdown. Protect these lines through Streamdown's block split
// and the first parse. Each descendant restores its own paragraph boundaries.
// The processing-instruction marker cannot close an existing HTML comment.
function protectBlankLines(source: string, allowOpen: boolean, markerPrefix: string): Edit[] {
  if (!source.includes("<")) return [];
  const blanks = Array.from(source.matchAll(BLANK_LINE));
  if (!blanks.length) return [];
  const edits: Edit[] = [];
  let covered = 0;
  let nextBlank = 0;
  for (const tag of scanMarkup(source).tags) {
    if (tag.start < covered || !startsFlow(source, tag)) continue;
    const candidateEnd = tag.pair?.start ?? (allowOpen && tag.name && HTML_BLOCK.has(tag.name) ? source.length : undefined);
    if (candidateEnd == null) continue;
    const prefix = linePrefix(source, tag.start);
    const container = markdownContainer(prefix);
    const end = endOfMarkdownContainer(source, tag.end, candidateEnd, container);
    covered = end;
    while (nextBlank < blanks.length && blanks[nextBlank].index < tag.end) nextBlank++;
    while (nextBlank < blanks.length && blanks[nextBlank].index < end) {
      const blank = blanks[nextBlank++];
      const padding = Math.max(0, prefix.length - blank[1].length);
      const insertAt = blank.index + blank[1].length;
      edits.push({ start: insertAt, end: insertAt, text: " ".repeat(padding) + markerPrefix + padding + "?>" });
    }
  }
  return edits;
}

function restoreBlankLines(source: string, marker: RegExp): Edit[] {
  return Array.from(source.matchAll(marker), (line) => {
    const insertedSpaces = Math.min(Number(line[2]), line[1].length - line[1].trimEnd().length);
    return { start: line.index + line[1].length - insertedSpaces, end: line.index + line[0].length, text: "" };
  });
}

function replaceSpans(source: string, edits: readonly Edit[]): string {
  if (!edits.length) return source;
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  return parts.join("") + source.slice(cursor);
}

export function normalizeHTMLBlockBlankLines(source: string, streaming = false): SourceView & { markerId: number } {
  // Reserve an id absent from the entire input. Only markers introduced by this
  // render may be decoded, even when the user's code shows this syntax verbatim.
  const used = new Set(Array.from(source.matchAll(/<\?deeix-md-blank:(\d+):/g), (match) => Number(match[1])));
  let markerId = 0;
  while (used.has(markerId)) markerId++;
  const edits = protectBlankLines(source, streaming, BLANK_MARKER_PREFIX + markerId + ":");
  return { ...rewrite({ text: source, offset: (index) => index }, edits), markerId };
}

function indentColumns(prefix: string): number {
  let columns = 0;
  for (const char of prefix) columns += char === "\t" ? 4 - columns % 4 : 1;
  return columns;
}

function layoutIndent(source: string): Edit[] {
  const firstBreak = source.indexOf("\n");
  // Real content on the opening tag's line starts at the container margin.
  // Do not infer a new margin from a later indented Markdown code block.
  if (firstBreak === -1 || source.slice(0, firstBreak).trim()) return [];
  const { tags, literals } = scanMarkup(source, true);
  const opaque = literals.concat(tags.flatMap(({ start, end }) => {
    const newline = source.indexOf("\n", start);
    return newline !== -1 && newline < end ? [{ start, end, kind: "html" as const }] : [];
  }));
  // A code payload (or a multiline HTML attribute) is not evidence of the
  // container's margin. Preserve relative indentation of lists and real code.
  opaque.sort((a, b) => a.start - b.start);
  let literalIndex = 0;
  let margin = Infinity;
  const lines = [];
  for (const line of source.matchAll(/^[ \t]*[^\r\n]*/gm)) {
    if (!line.index || !line[0]) continue;
    while (opaque[literalIndex]?.end <= line.index) literalIndex++;
    const literal = opaque[literalIndex];
    const inside = literal && literal.start < line.index && literal.end > line.index;
    if (inside && literal.kind === "html") continue;
    const prefix = /^[ \t]*/.exec(line[0])?.[0] ?? "";
    const columns = indentColumns(prefix);
    if (!inside && line[0].trim()) margin = Math.min(margin, columns);
    if (prefix) lines.push({ start: line.index, prefix });
  }
  if (!Number.isFinite(margin) || !margin) return [];
  // Four columns normally introduce Markdown code. Strip a wider margin only
  // when a paired block element at that margin establishes an HTML layout.
  if (margin >= 4 && !tags.some((tag) => {
    if (!tag.pair || !tag.name || !HTML_BLOCK.has(tag.name)) return false;
    const prefix = linePrefix(source, tag.start);
    return /^[ \t]*$/.test(prefix) && indentColumns(prefix) === margin && endsLine(source, tag.pair.end);
  })) return [];
  return lines.map(({ start, prefix }) => {
    let count = 0;
    let columns = 0;
    while (columns < margin && count < prefix.length) {
      columns += prefix[count++] === "\t" ? 4 - columns % 4 : 1;
    }
    return { start, end: start + count, text: " ".repeat(Math.max(0, columns - margin)) };
  });
}

function slice(view: SourceView, start: number, end?: number): SourceView {
  return { text: view.text.slice(start, end), offset: (index, bias) => view.offset(start + index, bias) };
}

// Compose exact edit coordinates, rather than diffing the contents of each
// recursively parsed fragment against the entire message on every render.
function rewrite(view: SourceView, edits: readonly Edit[]): SourceView {
  if (!edits.length) return view;
  let delta = 0;
  const spans = edits.map((edit) => {
    const from = edit.start + delta;
    const to = from + edit.text.length;
    delta = to - edit.end;
    return { from, to, ...edit };
  });
  return { text: replaceSpans(view.text, edits), offset(index, bias) {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid].from < index || (spans[mid].from === index && bias === "start")) lo = mid + 1;
      else hi = mid;
    }
    const span = spans[lo - 1];
    if (!span) return view.offset(index, bias);
    if (index < span.to) {
      // Replacement text maps to the selected edge of the source edit.
      const boundary = bias === "start" ? span.start : span.end;
      return view.offset(boundary, bias);
    }
    return view.offset(index + span.end - span.to, bias);
  } };
}

// remark serializes HTML one line at a time, omitting Markdown container
// prefixes. Align the retained suffixes directly; a long quote/list must not
// run a character diff or lose its source positions on a timeout.
function alignMarkupLines(raw: SourceView, value: string): SourceView {
  const original = raw.text.split(/(\r\n?|\n)/);
  const parsed = value.split(/(\r\n?|\n)/);
  const unmapped = { text: value, offset: () => undefined };
  if (original.length !== parsed.length) return unmapped;
  const edits: Edit[] = [];
  let start = 0;
  for (let i = 0; i < original.length; i++) {
    const before = original[i];
    const after = parsed[i];
    if (before !== after) {
      let sourcePrefixLength = before.length;
      let parsedPrefixLength = after.length;
      // Even parts are line text; odd parts are the captured line endings.
      if (i % 2 === 0) {
        while (
          sourcePrefixLength && parsedPrefixLength &&
          before[sourcePrefixLength - 1] === after[parsedPrefixLength - 1]
        ) {
          sourcePrefixLength--;
          parsedPrefixLength--;
        }
        // A partially consumed tab can also leave virtual spaces in the value.
        if (!/^[\t >]*$/.test(before.slice(0, sourcePrefixLength)) ||
          !/^[\t ]*$/.test(after.slice(0, parsedPrefixLength))) return unmapped;
      }
      edits.push({ start, end: start + sourcePrefixLength, text: after.slice(0, parsedPrefixLength) });
    }
    start += before.length;
  }
  return rewrite(raw, edits);
}

function qualifiedXmlEdits(source: string): Edit[] {
  if (!/<[A-Za-z][\w.-]*:/.test(source)) return [];
  const edits: Edit[] = [];
  for (const open of scanMarkup(source).tags) {
    if (!open.name?.includes(":") || !open.pair || !startsFlow(source, open)) continue;
    if (!FLOW_PREFIX.test(linePrefix(source, open.pair.start)) || !endsLine(source, open.pair.end)) continue;
    edits.push({ start: open.start, end: open.end, text: "<div>" }, { start: open.pair.start, end: open.pair.end, text: "</div>" });
  }
  return edits.sort((a, b) => a.start - b.start);
}

// CommonMark does not recognize a colon in a raw tag name. A qualified XML
// wrapper on its own line is layout only, so let it enter the same HTML path.
export function normalizeQualifiedXmlWrappers(source: string): string {
  return replaceSpans(source, qualifiedXmlEdits(source));
}

// Keep real HTML tags as raw nodes for rehype-raw and the existing sanitizer.
// Run Markdown on the contents in the coordinate system of their container.
export const remarkMarkdownInMarkup = (function(this: MarkdownParser, markerId: number) {
  const marker = createBlankMarker(markerId);
  const parse = this.parse.bind(this);
  return (tree: MarkdownNode, file: { value: unknown }) => {
    if (typeof file.value !== "string" || !file.value.includes("<")) return;
    const position = createPositionLookup(file.value);
    const locate = (view: SourceView, start?: number, end?: number): SourcePosition | undefined => {
      const a = start == null ? undefined : view.offset(start, "start");
      const b = end == null ? undefined : view.offset(end, "end");
      return a != null && b != null && a <= b ? position(a, b) : undefined;
    };
    function atom(type: "html" | typeof HTML_LITERAL_TEXT, view: SourceView, start = 0, end = view.text.length): MarkdownNode {
      return { type, value: view.text.slice(start, end), position: locate(view, start, end) };
    }

    function rawView(view: SourceView, node: MarkdownNode): SourceView | undefined {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start == null || end == null || !node.value) return;
      const raw = slice(view, start, end);
      if (raw.text === node.value) return raw;
      return alignMarkupLines(raw, node.value);
    }

    function fragment(view: SourceView, depth: number, phrasing: boolean, inContainer: boolean): MarkdownNode[] {
      if (!view.text.trim()) return [];
      view = rewrite(view, restoreBlankLines(view.text, marker.line));
      if (inContainer) view = rewrite(view, layoutIndent(view.text));
      view = rewrite(view, qualifiedXmlEdits(view.text));
      // An unfinished nested tag can own the rest of this container while
      // streaming, just as it does at the outer document boundary.
      view = rewrite(view, protectBlankLines(view.text, inContainer, marker.prefix));
      const root = parse(view.text);
      visit(root, view, depth);
      const children = root.children ?? [];
      if (phrasing) return children.flatMap((child): MarkdownNode[] => child.type === "paragraph" ? (child.children ?? []) : [child]);
      if (inContainer) {
        for (const child of children) {
          if (child.type === "paragraph") child.data = { ...child.data, hName: MARKUP_PARAGRAPH };
        }
      }
      return children;
    }

    function literal(body: SourceView, tag: string): MarkdownNode[] {
      body = rewrite(body, restoreBlankLines(body.text, marker.line));
      const code = tag === "pre"
        ? /^(\s*)(<code(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/code\s*>)\s*$/i.exec(body.text)
        : null;
      if (!code) return [atom(HTML_LITERAL_TEXT, body)];
      const text = code[1].length + code[2].length;
      const close = text + code[3].length;
      return [atom("html", body, code[1].length, text), atom(HTML_LITERAL_TEXT, body, text, close), atom("html", body, close, close + code[4].length)];
    }

    function expand(view: SourceView, depth: number): MarkdownNode[] | undefined {
      if (depth >= MAX_MARKUP_DEPTH) return;
      const { tags } = scanMarkup(view.text, true, marker.paragraphBreak);
      if (!tags.length || view.text.slice(0, tags[0].start).trim()) return;
      const result: MarkdownNode[] = [];
      let cursor = 0;
      // Sibling tags share a level; do not spend the nesting budget on each one.
      for (const tag of tags) {
        if (tag.start < cursor) continue;
        if (view.text.slice(cursor, tag.start).trim()) break;
        const { name, pair, start, end } = tag;
        if (!name || tag.empty || tag.closing) {
          result.push(atom("html", view, start, end));
          cursor = end;
          continue;
        }
        if (HTML_LITERAL.has(name) && (!pair || !HTML_CODE.has(name))) {
          cursor = pair?.end ?? view.text.length;
          const raw = slice(view, start, cursor);
          result.push(atom("html", rewrite(raw, restoreBlankLines(raw.text, marker.line))));
          continue;
        }
        const body = slice(view, end, pair?.start);
        if (!pair && !HTML_BLOCK.has(name) && !HTML_PHRASING.has(name)) {
          result.push(atom("html", view, start));
          return result;
        }
        result.push(atom("html", view, start, end));
        if (pair && HTML_CODE.has(name)) result.push(...literal(body, name));
        else result.push(...fragment(body, depth + 1, HTML_PHRASING.has(name), true));
        if (pair) result.push(atom("html", view, pair.start, pair.end));
        cursor = pair?.end ?? view.text.length;
      }
      if (view.text.slice(cursor).trim()) result.push(...fragment(slice(view, cursor), depth + 1, false, false));
      return result;
    }

    function visit(parent: MarkdownNode, view: SourceView, depth: number) {
      const original = parent.position;
      if (original) parent.position = locate(view, original.start.offset, original.end.offset);
      if (!parent.children) return;
      const children = parent.children;
      const result: MarkdownNode[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === "html") {
          const name = /^<(code|pre|kbd|samp)(?=[\s>])(?:[^<>"']|"[^"]*"|'[^']*')*>$/i.exec(child.value ?? "")?.[1].toLowerCase();
          const from = child.position?.end.offset;
          if (name && from != null) {
            const endTag = new RegExp("^</" + name + "\\s*>$", "i");
            const close = children.findIndex((candidate, j) => j > i && candidate.type === "html" &&
              endTag.test(candidate.value ?? ""));
            const to = children[close]?.position?.start.offset;
            const start = child.position?.start.offset;
            const end = children[close]?.position?.end.offset;
            if (to != null && start != null && end != null) {
              result.push(atom("html", view, start, from), ...literal(slice(view, from, to), name), atom("html", view, to, end));
              i = close;
              continue;
            }
          }
          const raw = rawView(view, child);
          const expanded = raw && expand(raw, depth);
          if (expanded) { result.push(...expanded); continue; }
        }
        visit(child, view, depth);
        result.push(child);
      }
      parent.children = result;
    }

    visit(tree, { text: file.value, offset: (index) => index }, 0);
  };
  // Type assertion: Streamdown exposes a generic plugin type; this parser uses mdast nodes.
}) as RemarkPlugin;
