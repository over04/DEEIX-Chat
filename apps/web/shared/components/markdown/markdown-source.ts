import { diffChars } from "diff";
import type { StreamdownProps } from "streamdown";
import type { SourcePosition } from "./streamdown-mixed-markup";

export type BoundaryBias = "start" | "end";
export type SourceOffset = (offset: number, bias: BoundaryBias) => number | undefined;
export type SourceRange = readonly [number, number];

type Span = { from: number; to: number; start: number; end: number; matched: boolean };

// Reuse the alignment only if a copy is requested. A normal render/stream tick
// does not run the diff. Bias at a deleted span keeps unselected punctuation out.
export function sourceOffsetMap(original: string, display: string): SourceOffset {
  if (original === display) return (offset) => offset >= 0 && offset <= original.length ? offset : undefined;
  let spans: Span[] | undefined;
  return (offset, bias) => {
    if (offset < 0 || offset > display.length) return;
    if (!spans) {
      spans = [];
      const changes = diffChars(original, display, { maxEditLength: 6000, timeout: 55 });
      let from = 0;
      let start = 0;
      if (changes) {
        for (let i = 0; i < changes.length; i++) {
          const part = changes[i];
          if (!part.added && !part.removed) {
            const length = part.value.length;
            spans.push({ from, to: from + length, start, end: start + length, matched: true });
            from += length;
            start += length;
            continue;
          }
          let added = 0;
          let removed = 0;
          while (i < changes.length && (changes[i].added || changes[i].removed)) {
            if (changes[i].added) added += changes[i].value.length;
            else removed += changes[i].value.length;
            i++;
          }
          i--;
          spans.push({ from, to: from + added, start, end: start + removed, matched: false });
          from += added;
          start += removed;
        }
      } else {
        let prefix = 0;
        let suffix = 0;
        while (prefix < Math.min(original.length, display.length) && original[prefix] === display[prefix]) prefix++;
        while (suffix < Math.min(original.length, display.length) - prefix && original.at(-1 - suffix) === display.at(-1 - suffix)) suffix++;
        spans.push({ from: 0, to: prefix, start: 0, end: prefix, matched: true });
        spans.push({ from: prefix, to: display.length - suffix, start: prefix, end: original.length - suffix, matched: false });
        spans.push({ from: display.length - suffix, to: display.length, start: original.length - suffix, end: original.length, matched: true });
      }
    }
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (spans[mid].to < offset) lo = mid + 1;
      else hi = mid;
    }
    let first: number | undefined;
    let last: number | undefined;
    for (let i = lo; i < spans.length && spans[i].from <= offset; i++) {
      const span = spans[i];
      if (span.from === span.to) {
        first ??= span.start;
        last = span.end;
      } else if (span.matched) {
        const point = span.start + offset - span.from;
        first ??= point;
        last = point;
      } else if (offset === span.from || offset === span.to || span.start === span.end) {
        const point = offset === span.to ? span.end : span.start;
        first ??= point;
        last = point;
      }
    }
    return bias === "start" ? last : first;
  };
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: SourcePosition;
};

type RehypePlugin = NonNullable<StreamdownProps["rehypePlugins"]>[number];

const STRUCTURAL_TAGS = new Set(["table", "colgroup", "thead", "tbody", "tfoot", "tr", "ul", "ol", "dl", "select", "svg", "math"]);
const INLINE_TAGS = new Set(["a", "b", "code", "del", "em", "i", "s", "span", "strong", "sub", "sup", "u"]);
const ATOMIC_TAGS = new Set(["br", "hr", "img", "pre"]);

function rangeValue(node: HastNode): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start == null || end == null || start >= end) return;
  return start + ":" + end;
}

function classIncludes(node: HastNode, name: string): boolean {
  const value = node.properties?.className;
  return typeof value === "string" ? value.split(/\s+/).includes(name) : Array.isArray(value) && value.includes(name);
}

// Insert copy metadata after the untrusted HTML sanitizer; it cannot be supplied
// by a reply. Text spans give precise endpoints, also when the DOM contains
// supplementary children, e.g. code line numbers or MathML.
export const rehypeMarkdownCopySource = (function rehypeMarkdownCopySource() {
  return (tree: HastNode) => {
    function decorate(parent: HastNode) {
      if (!parent.children) return;
      parent.children = parent.children.map((node) => {
        const range = rangeValue(node);
        if (node.type === "text" && range && node.value?.trim() && !STRUCTURAL_TAGS.has(parent.tagName ?? "")) {
          return { type: "element", tagName: "span", properties: { "data-md-text": range }, children: [node] };
        }
        if (node.type !== "element" || !node.tagName) return node;
        const tag = node.tagName;
        const math = (tag === "code" && (classIncludes(node, "language-math") || classIncludes(node, "math-inline"))) ||
          (tag === "pre" && node.children?.some((item) => classIncludes(item, "language-math") || classIncludes(item, "math-display")));
        if (math && range) {
          return {
            type: "element", tagName: tag === "pre" ? "div" : "span",
            properties: { "data-md-atomic": "math", "data-md-range": range }, children: [node],
          };
        }
        if (range) {
          node.properties ??= {};
          node.properties["data-md-range"] = range;
          if (ATOMIC_TAGS.has(tag) || tag === "code") node.properties["data-md-atomic"] = tag;
          else if (INLINE_TAGS.has(tag)) node.properties["data-md-inline"] = tag;
        }
        if (!ATOMIC_TAGS.has(tag) && tag !== "code" && tag !== "math" && tag !== "svg") decorate(node);
        return node;
      });
    }
    decorate(tree);
  };
  // Type assertion: Streamdown exposes generic plugins; this callback uses the hast shape.
}) as RehypePlugin;
