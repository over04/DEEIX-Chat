import type { StreamdownProps } from "streamdown";

export type SourcePoint = { line: number; column: number; offset?: number };
export type SourcePosition = { start: SourcePoint; end: SourcePoint };

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: SourcePosition;
};

type MarkdownParser = { parse: (source: string) => MarkdownNode };
type RemarkPlugin = NonNullable<StreamdownProps["remarkPlugins"]>[number];

const HTML_TOKEN = /<!--[\s\S]*?(?:-->|$)|<(\/?)([A-Za-z][\w:.-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
const HTML_LITERAL = new Set(["code", "pre", "script", "style", "textarea", "template", "iframe", "noscript", "title", "svg", "math", "plaintext", "xmp", "noembed", "noframes"]);
const HTML_CODE = new Set(["code", "pre", "kbd", "samp"]);
const HTML_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const HTML_PHRASING = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "del", "em", "i", "ins", "kbd", "label", "mark", "p", "q", "s", "small", "span", "strong", "sub", "summary", "sup", "u", "var", "h1", "h2", "h3", "h4", "h5", "h6"]);
const HTML_BLOCK = new Set(["article", "aside", "blockquote", "caption", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "header", "li", "main", "nav", "ol", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);

export function transformOutsideLiteralMarkup(source: string, transform: (part: string) => string): string {
  let at = 0;
  let result = "";
  for (const match of source.matchAll(/<(pre|code|kbd|samp|script|style|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>/gi)) {
    result += transform(source.slice(at, match.index)) + match[0];
    at = match.index + match[0].length;
  }
  return result + transform(source.slice(at));
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

// Markdown inside an HTML block can have literal <tags> in code. Skip fenced
// blocks and code spans when finding the real closing tag of its wrapper.
function codeRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  const lines = /^([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let fence: { start: number; marker: string } | undefined;
  for (const m of source.matchAll(lines)) {
    if (!fence) fence = { start: m.index, marker: m[2] };
    else if (m[2][0] === fence.marker[0] && m[2].length >= fence.marker.length && !m[3].trim()) {
      ranges.push([fence.start, m.index + m[0].length]);
      fence = undefined;
    }
  }
  if (fence) ranges.push([fence.start, source.length]);
  return ranges;
}

function findClosingTag(source: string, tag: string, from: number): RegExpExecArray | undefined {
  const pattern = new RegExp(HTML_TOKEN.source, "g");
  const backticks = /`+/g;
  const fences = codeRanges(source);
  let fenceIndex = 0;
  let depth = 1;
  let literal: string | undefined;
  pattern.lastIndex = from;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    while (fenceIndex < fences.length && fences[fenceIndex][1] < m.index) fenceIndex++;
    const fence = fences[fenceIndex];
    if (!literal && fence && fence[0] <= m.index && m.index < fence[1]) {
      pattern.lastIndex = fence[1];
      continue;
    }
    // Only paired runs protect inline code. An orphan backtick is ordinary text.
    while (!literal && backticks.lastIndex <= m.index) {
      const open = backticks.exec(source);
      if (!open || open.index >= m.index) {
        backticks.lastIndex = m.index + m[0].length;
        break;
      }
      if (open.index < from || fences.some(([start, end]) => start <= open.index && open.index < end)) continue;
      const close = new RegExp("(^|[^`])(" + "`".repeat(open[0].length) + ")(?!`)", "g");
      close.lastIndex = open.index + open[0].length;
      const match = close.exec(source);
      if (match && !/\r?\n[ \t]*\r?\n/.test(source.slice(open.index, match.index))) {
        backticks.lastIndex = close.lastIndex;
        if (close.lastIndex > m.index) break;
      }
    }
    if (!literal && backticks.lastIndex > m.index + m[0].length) {
      pattern.lastIndex = backticks.lastIndex;
      continue;
    }
    if (!m[2]) continue;
    const name = m[2].toLowerCase();
    if (literal) {
      if (name === literal && m[1]) literal = undefined;
      continue;
    }
    if (!m[1] && HTML_LITERAL.has(name) && !/\/\s*>$/.test(m[0])) {
      literal = name;
    } else if (name === tag) {
      if (m[1] && --depth === 0) return m;
      if (!m[1] && !/\/\s*>$/.test(m[0])) depth++;
    }
  }
}

// CommonMark does not recognize a colon in a raw tag name. A qualified XML
// wrapper on its own line is layout only, so let it enter the same HTML path.
export function normalizeQualifiedXmlWrappers(source: string): string {
  if (!source.includes(":")) return source;
  const tokens = new RegExp(HTML_TOKEN.source, "g");
  const ranges = codeRanges(source);
  const stack: RegExpExecArray[] = [];
  const replacements: { start: number; end: number; value: string }[] = [];
  let literal: string | undefined;
  for (let token = tokens.exec(source); token; token = tokens.exec(source)) {
    const tag = token[2]?.toLowerCase();
    if (!tag || ranges.some(([start, end]) => start <= token.index && token.index < end)) continue;
    if (literal) {
      if (token[1] && literal === tag) literal = undefined;
      continue;
    }
    if (!token[1] && HTML_LITERAL.has(tag) && !/\/\s*>$/.test(token[0])) { literal = tag; continue; }
    if (!tag.includes(":") || /\/\s*>$/.test(token[0])) continue;
    const end = token.index + token[0].length;
    const lineStart = source.lastIndexOf("\n", token.index - 1) + 1;
    const lineEnd = source.indexOf("\n", end);
    if (!/^[ \t]{0,3}$/.test(source.slice(lineStart, token.index)) || source.slice(end, lineEnd === -1 ? undefined : lineEnd).trim()) continue;
    if (!token[1]) stack.push(token);
    else if (stack.at(-1)?.[2].toLowerCase() === tag) {
      const open = stack.pop();
      if (!open) continue;
      replacements.push({ start: open.index, end: open.index + open[0].length, value: "<div>" }, { start: token.index, end, value: "</div>" });
    }
  }
  if (!replacements.length) return source;
  let result = "";
  let cursor = 0;
  for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
    result += source.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return result + source.slice(cursor);
}

// Reparse the contents of raw HTML *before* remark-rehype. Keeping raw tags as
// separate nodes lets the existing rehype-raw and sanitizer assemble the tree
// and filter all tags, attributes and URLs, including the recursively parsed ones.
export const remarkMarkdownInMarkup = (function(this: MarkdownParser) {
  const parse = this.parse.bind(this);
  return (tree: MarkdownNode, file: { value: unknown }) => {
    if (typeof file.value !== "string" || !file.value.includes("<")) return;
    const input = file.value;
    const position = createPositionLookup(input);
    const atom = (type: "html" | "text", value: string, offset: number): MarkdownNode => ({ type, value, position: position(offset, offset + value.length) });
    const raw = (value: string, offset: number) => atom("html", value, offset);

    function fragment(source: string, base: number, depth: number, phrasing: boolean): MarkdownNode[] {
      if (!source.trim()) return [];
      // The streaming HTML normalizer keeps raw blocks together with this
      // comment on empty lines. Restore those paragraph boundaries at equal width.
      const input = source.replace(/^[ \t]*<!-- -->[ \t]*$/gm, (line) => " ".repeat(line.length));
      const root = parse(input);
      function shift(node: MarkdownNode) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start != null && end != null) node.position = position(start + base, end + base);
        node.children?.forEach(shift);
      }
      shift(root);
      visit(root, depth);
      const children = root.children ?? [];
      if (!phrasing) return children;
      // <p>, headings, <summary>, etc. cannot legally contain another <p>.
      return children.flatMap((child): MarkdownNode[] => child.type === "paragraph" ? (child.children ?? []) : [child]);
    }

    function expand(node: MarkdownNode, depth: number): MarkdownNode[] {
      if (node.type !== "html" || depth > 20 || !node.value || node.position?.start.offset == null) return [node];
      const source = node.value;
      const start = node.position.start.offset;
      const opener = new RegExp(HTML_TOKEN.source, "g").exec(source);
      if (!opener?.[2] || opener[1] || source.slice(0, opener.index).trim() || /\/\s*>$/.test(opener[0])) return [node];
      const tag = opener[2].toLowerCase();
      const from = opener.index + opener[0].length;
      if (HTML_CODE.has(tag)) {
        const closing = findClosingTag(source, tag, from);
        if (!closing) return [node];
        const after = closing.index + closing[0].length;
        const inner = source.slice(from, closing.index);
        const code = tag === "pre" ? /^(\s*)(<code\b[^>]*>)([\s\S]*?)(<\/code\s*>)\s*$/i.exec(inner) : null;
        const text = code ? start + from + code[1].length + code[2].length : start + from;
        const contents = code
          ? [raw(code[2], text - code[2].length), atom("text", code[3], text), raw(code[4], text + code[3].length)]
          : [atom("text", inner, text)];
        return [raw(opener[0], start + opener.index), ...contents, raw(closing[0], start + closing.index),
          ...fragment(source.slice(after), start + after, depth + 1, false)];
      }
      if (HTML_LITERAL.has(tag) || HTML_VOID.has(tag)) return [node];
      if (!source.slice(from).trim()) return [node];
      const closing = findClosingTag(source, tag, from);
      if (!closing && !HTML_BLOCK.has(tag) && !HTML_PHRASING.has(tag)) return [node];
      const result = [raw(opener[0], start + opener.index)];
      result.push(...fragment(source.slice(from, closing?.index), start + from, depth + 1, HTML_PHRASING.has(tag)));
      if (closing) {
        result.push(raw(closing[0], start + closing.index));
        const after = closing.index + closing[0].length;
        result.push(...fragment(source.slice(after), start + after, depth + 1, false));
      }
      return result;
    }

    function visit(parent: MarkdownNode, depth: number) {
      if (!parent.children) return;
      const children = parent.children;
      const result: MarkdownNode[] = [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === "html") {
          const name = /^<([A-Za-z]+)(?:\s[^<>]*)?>$/.exec(child.value ?? "")?.[1].toLowerCase();
          const from = child.position?.end.offset;
          if (name && from != null && HTML_CODE.has(name)) {
            const close = children.findIndex((candidate, j) => j > i && candidate.type === "html" &&
              (candidate.value ?? "").toLowerCase() === "</" + name + ">");
            const to = children[close]?.position?.start.offset;
            if (to != null) {
              result.push(child, atom("text", input.slice(from, to), from), children[close]);
              i = close;
              continue;
            }
          }
          result.push(...expand(child, depth));
        } else {
          if (child.type !== "code" && child.type !== "inlineCode") visit(child, depth);
          result.push(child);
        }
      }
      parent.children = result;
    }

    visit(tree, 0);
  };
  // Type assertion: Streamdown exposes generic plugins; this callback uses the mdast shape.
}) as RemarkPlugin;
