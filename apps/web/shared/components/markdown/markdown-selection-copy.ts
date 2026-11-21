import { formulaSource, RENDERED_MATH } from "./clipboard-math";
import { type SourceOffset, type SourceRange, sourceOffsetMap } from "./markdown-source";

const SCOPE = "[data-md-copy-scope]";
const LEAF = "[data-md-text], [data-md-atomic]";
const CONTROLS = "input, textarea, select, button, [contenteditable]:not([contenteditable='false'])";
const CODE_BODY = "[data-streamdown='code-block-body']";

export type CopyDocument = { source: string };
export type CopyScope = { document: CopyDocument; map: SourceOffset };
const scopeSources = new WeakMap<HTMLElement, CopyScope>();

export function registerMarkdownCopyScope(scope: HTMLElement, value: CopyScope) {
  scopeSources.set(scope, value);
  return () => { scopeSources.delete(scope); };
}

function offsets(value: string | null): SourceRange | undefined {
  if (!value) return;
  const [start, end] = value.split(":").map(Number);
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end) return [start, end];
}

function readRange(element: HTMLElement, scope: CopyScope, text = false): SourceRange | undefined {
  const range = offsets(element.getAttribute(text ? "data-md-text" : "data-md-range"));
  if (!range) return;
  const start = scope.map(range[0], "start");
  const end = scope.map(range[1], "end");
  if (start != null && end != null && start < end && end <= scope.document.source.length) return [start, end];
}

function isElement(node: Node): node is Element { return node.nodeType === 1; }
function asElement(node: Node) { return isElement(node) ? node : node.parentElement; }

function clipTextContent(node: HTMLElement, selection: Range): { start: number; end: number; text: string } | undefined {
  const text = node.textContent ?? "";
  if (!text.length || !selection.intersectsNode(node)) return;
  let start = 0;
  let end = text.length;
  if (node.contains(selection.startContainer)) {
    const prefix = node.ownerDocument.createRange();
    prefix.selectNodeContents(node);
    prefix.setEnd(selection.startContainer, selection.startOffset);
    start = prefix.toString().length;
  }
  if (node.contains(selection.endContainer)) {
    const prefix = node.ownerDocument.createRange();
    prefix.selectNodeContents(node);
    prefix.setEnd(selection.endContainer, selection.endOffset);
    end = prefix.toString().length;
  }
  if (end > start) return { start, end, text };
}

type Hit = { element: HTMLElement; scope: CopyScope; range: SourceRange; start: number; end: number; explicit?: string };

function trimInlineCode(raw: string, element: HTMLElement, selected: NonNullable<ReturnType<typeof clipTextContent>>): string {
  const run = /^(`+)/.exec(raw)?.[1];
  if (!run || !raw.endsWith(run)) return selected.text.slice(selected.start, selected.end);
  const inside = raw.slice(run.length, -run.length);
  const visible = element.textContent ?? "";
  const coordinate = sourceOffsetMap(inside, visible);
  const start = coordinate(selected.start, "start");
  const end = coordinate(selected.end, "end");
  const source = start != null && end != null && start < end ? inside.slice(start, end) : visible.slice(selected.start, selected.end);
  const pad = source.startsWith("`") || source.endsWith("`") || (/^\s[\s\S]*\s$/.test(source) && source.trim());
  return run + (pad ? " " + source + " " : source) + run;
}

function clipCodeBlock(raw: string, element: HTMLElement, selection: Range, selectedText: string): string | undefined {
  const body = element.querySelector<HTMLElement>(CODE_BODY);
  if (!body || (!body.contains(selection.startContainer) && !body.contains(selection.endContainer))) return;
  const pos = raw.indexOf("\n");
  const open = /^([\t ]*(?:>[\t ]*)*)(`{3,}|~{3,})/.exec(raw);
  // Streamdown renders each highlighted line in its own span; a DOM Range's
  // string omits those structural newlines. Read rows without CSS line numbers.
  const rows = Array.from(body.querySelectorAll<HTMLElement>("pre > code > span"));
  const clipped = rows.length ? rows.filter((row) => selection.intersectsNode(row)).map((row) => {
    const selected = clipTextContent(row, selection);
    return selected?.text.slice(selected.start, selected.end) ?? "";
  }).join("\n") : selectedText;
  if (!clipped) return;
  if (!open || pos < 0) return clipped.split("\n").map((line) => "    " + line).join("\n");
  const close = new RegExp("(?:^|\\n)([\\t >]*" + open[2][0] + "{" + open[2].length + ",}[\\t ]*)\\r?$").exec(raw)?.[1];
  return raw.slice(0, pos + 1) + clipped.replace(/\n$/, "") + "\n" + (close ?? open[1] + open[2]);
}

function collectHits(scopeElement: HTMLElement, scope: CopyScope, selection: Range, visible: string): Hit[] {
  const hits: Hit[] = [];
  for (const element of scopeElement.querySelectorAll<HTMLElement>(LEAF)) {
    if (element.closest(SCOPE) !== scopeElement || !selection.intersectsNode(element)) continue;
    const atom = element.getAttribute("data-md-atomic");
    const enclosingAtom = element.closest<HTMLElement>("[data-md-atomic]");
    if (enclosingAtom && enclosingAtom !== element) continue;
    if (element.closest("[hidden], [aria-hidden='true'], [data-footnote-backref]")) continue;
    if (atom === "pre" && !element.querySelector(CODE_BODY) && !element.textContent?.trim() && !element.querySelector("svg, canvas, img")) continue;
    const range = readRange(element, scope, !atom);
    if (!range) continue;
    let [start, end] = range;
    const raw = scope.document.source.slice(start, end);
    let explicit: string | undefined;
    if (!atom || atom === "code") {
      const selected = clipTextContent(element, selection);
      if (!selected) continue;
      if (selected.start > 0 || selected.end < selected.text.length) {
        if (atom) explicit = trimInlineCode(raw, element, selected);
        else {
          const map = sourceOffsetMap(raw, selected.text);
          const a = selected.start === 0 ? 0 : map(selected.start, "start");
          const b = selected.end === selected.text.length ? raw.length : map(selected.end, "end");
          if (a == null || b == null || a >= b) explicit = selected.text.slice(selected.start, selected.end);
          else { end = start + b; start += a; }
        }
      }
    } else if (atom === "pre") explicit = clipCodeBlock(raw, element, selection, visible);
    hits.push({ element, scope, range, start, end, explicit });
  }
  return hits;
}

function scopeForElement(element: HTMLElement) {
  const scope = element.closest<HTMLElement>(SCOPE);
  return scope ? scopeSources.get(scope) : undefined;
}

function formatBoundaries(first: Hit, last: Hit, source: string) {
  let start = first.start;
  let end = last.end;
  let prefix = "";
  let suffix = "";
  const apply = (hit: Hit, leading: boolean) => {
    for (let node = hit.element.parentElement; node && !node.matches(SCOPE); node = node.parentElement) {
      const scope = scopeForElement(node);
      if (!scope || scope.document !== hit.scope.document) break;
      const outer = readRange(node, scope);
      if (!outer) continue;
      const leaves = Array.from(node.querySelectorAll<HTMLElement>(LEAF)).filter((leaf) => {
        const atom = leaf.closest("[data-md-atomic]");
        return !atom || leaf === atom;
      });
      const edge = leading ? leaves[0] : leaves.at(-1);
      const adjacent = edge && readRange(edge, scope, edge.hasAttribute("data-md-text"));
      if (!adjacent) continue;
      const inline = node.hasAttribute("data-md-inline");
      const includesEdge = leading ? adjacent[0] >= start : adjacent[1] <= end;
      if (includesEdge) {
        if (leading) start = Math.min(start, outer[0]);
        else end = Math.max(end, outer[1]);
      } else if (inline && (leading ? outer[0] < start : outer[1] > end)) {
        if (leading) prefix = source.slice(outer[0], adjacent[0]) + prefix;
        else suffix += source.slice(adjacent[1], outer[1]);
      }
    }
  };
  apply(first, true);
  apply(last, false);
  return { start, end, prefix, suffix };
}

function renderHits(hits: Hit[]) {
  const source = hits[0].scope.document.source;
  // Generated footnotes can appear after later source blocks. Preserve document
  // order without spanning across the same source bytes a second time.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const { start, end, prefix, suffix } = formatBoundaries(hits[0], hits[hits.length - 1], source);
  let text = prefix;
  let cursor = start;
  for (const hit of hits) {
    if (hit.explicit == null || hit.start < cursor || hit.end > end) continue;
    text += source.slice(cursor, hit.start) + hit.explicit;
    cursor = hit.end;
  }
  return text + source.slice(cursor, end) + suffix;
}

export function selectedMarkdown(selection: Selection, owner: Document): string | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const start = asElement(range.startContainer);
  const end = asElement(range.endContainer);
  if (start?.closest(CONTROLS) || end?.closest(CONTROLS)) return;
  const firstScope = start?.closest<HTMLElement>(SCOPE);
  const lastScope = end?.closest<HTMLElement>(SCOPE);
  const markdownRoot = "[data-chat-markdown-scope]";
  // Mixed selections may include an attachment label or other surrounding UI.
  // Leave those to native copy instead of silently dropping the selected text.
  if ((!firstScope && !start?.closest(markdownRoot)) || (!lastScope && !end?.closest(markdownRoot))) return;
  const scopes = firstScope && firstScope === lastScope ? [firstScope] : owner.querySelectorAll<HTMLElement>(SCOPE);
  const groups = new Map<CopyDocument, Hit[]>();
  const visible = selection.toString();
  for (const element of scopes) {
    if (!range.intersectsNode(element)) continue;
    const scope = scopeSources.get(element);
    if (!scope) continue;
    const hits = collectHits(element, scope, range, visible);
    if (!hits.length) continue;
    const group = groups.get(scope.document);
    if (group) group.push(...hits);
    else groups.set(scope.document, hits);
  }
  if (groups.size) return Array.from(groups.values(), renderHits).join("\n\n");
}

const FORMULA = RENDERED_MATH + ", [data-md-atomic='math']";

export function messageSelectionSource(root: HTMLElement): { markdown?: string; latex?: string } | undefined {
  const owner = root.ownerDocument;
  const selection = owner.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(root)) return;
  const contained = root.contains(range.startContainer) && root.contains(range.endContainer);
  const markdownRoot = "[data-chat-markdown-scope]";
  let markdown: string | undefined;
  if (root.matches(markdownRoot) || root.querySelector(markdownRoot)) {
    markdown = selectedMarkdown(selection, owner);
  } else if (contained) {
    markdown = selection.toString();
  }
  let atom = contained ? asElement(range.commonAncestorContainer)?.closest(FORMULA) : undefined;
  if (!atom && contained && range.startContainer === range.endContainer && range.endOffset === range.startOffset + 1) {
    const node = range.startContainer.childNodes[range.startOffset];
    if (node && isElement(node) && node.matches(FORMULA)) atom = node;
  }
  const latex = atom ? formulaSource(atom) : undefined;
  return markdown || latex ? { markdown, latex } : undefined;
}
