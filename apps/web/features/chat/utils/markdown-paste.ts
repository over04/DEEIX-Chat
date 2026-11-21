import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

import { escapeStructuralMarkdown } from "@/features/chat/utils/markdown-escape";
import { clipboardFormulaMarkdown, CLIPBOARD_LATEX, copyMath, KATEX_OR_MATHML, MATHML_NAMESPACE } from "@/shared/components/markdown/clipboard-math";
import { CLIPBOARD_CODE_LABEL } from "@/shared/components/markdown/markdown-rich-copy";
import { CODE_BLOCK_PLAIN_TEXT_MIME } from "@/shared/lib/clipboard";
import { isRecord } from "@/shared/lib/type-guards";

type ClipboardMarkdownPaste = {
  block: boolean;
  markdown: string;
};

const VSCODE_EDITOR_DATA_MIME = "vscode-editor-data";
const VSCODE_NON_CODE_MODES = new Set(["markdown", "mdx", "plaintext"]);
const VSCODE_MARKDOWN_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  javascriptreact: "jsx",
  shellscript: "bash",
  typescriptreact: "tsx",
};
const HTML_BLOCK_SELECTOR = [
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
].join(",");

const turndownService = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  preformattedCode: true,
  strongDelimiter: "**",
});
turndownService.use(gfm);
turndownService.remove(["script", "style", "noscript", "template", "iframe", "object", "embed"]);
turndownService.escape = (text) => escapeStructuralMarkdown(text.replace(/[&<>$]/g, (char) => `&#${char.charCodeAt(0)};`));
turndownService.addRule("presentationMathML", {
  filter: (element) => element.localName === "math" && element.namespaceURI === MATHML_NAMESPACE && !element.closest("pre, code"),
  replacement: (_content, element) => {
    if (element.nodeType !== 1 || !("outerHTML" in element) || typeof element.outerHTML !== "string") return "";
    // Keep native equation structure; entities prevent Markdown parsers from
    // treating equation text as emphasis, math delimiters, or table separators.
    const markup = element.outerHTML.replace(/[\\`*_~$[\]|\r\n]/g, (char) => `&#${char.charCodeAt(0)};`);
    return element.getAttribute("display") === "block" && !element.closest("td, th") ? "\n\n" + markup + "\n\n" : markup;
  },
});

const STYLED_TEXT_TAGS = new Set(["a", "b", "del", "em", "i", "mark", "p", "s", "small", "span", "strong", "u"]);
const SEMANTIC_INLINE_TAGS = new Set(["abbr", "kbd", "mark", "samp", "small", "sub", "sup", "u", "var"]);

function clipboardTextStyle(element: Element): string {
  if (!STYLED_TEXT_TAGS.has(element.localName) || !("style" in element) || element.closest("pre, code, math")) return "";
  const source = (element as HTMLElement).style;
  const preview = element.ownerDocument.createElement("span");
  for (const name of ["color", "background-color", "font-weight", "font-style", "font-size", "font-family", "white-space"]) {
    const value = source.getPropertyValue(name);
    // The semantic tag already becomes Markdown bold; keep only additional styling.
    if (name === "font-weight" && /^(?:bold|700)$/.test(value) && /^(?:b|strong)$/.test(element.localName)) continue;
    if (!value || /(?:url\s*\(|var\s*\(|expression\s*\(|["'&;\\<>])/i.test(value)) continue;
    if (name === "white-space" && !/^(?:pre|pre-wrap|break-spaces)$/.test(value)) continue;
    preview.style.setProperty(name, value);
  }
  return preview.getAttribute("style") ?? "";
}

function normalizeStyledClipboardLinks(body: HTMLElement) {
  for (const link of body.querySelectorAll("a[style]")) {
    const style = clipboardTextStyle(link);
    if (!style) continue;
    // Style just the label so Turndown's link rule can escape the destination
    // and preserve the title, including for relative URLs.
    const label = body.ownerDocument.createElement("span");
    label.setAttribute("style", style);
    while (link.firstChild) label.append(link.firstChild);
    link.removeAttribute("style");
    link.append(label);

    const href = link.getAttribute("href");
    if (!href) continue;
    try {
      const { protocol } = new URL(href, "https://clipboard.invalid");
      if (["http:", "https:", "mailto:", "tel:"].includes(protocol)) {
        // Turndown would emit \( and \), which the chat renderer reads as math.
        // Markdown character references round-trip to the original destination.
        if (/[()]/.test(href)) link.setAttribute("href", href.replace(/[&()]/g, (char) => "&#" + char.charCodeAt(0) + ";"));
        continue;
      }
    } catch {
      // Keep the label as styled text when the destination is invalid.
    }
    link.removeAttribute("href");
  }
}

function codeLanguage(element: Element): string {
  return Array.from(element.classList).find((name) => /^language-[a-z0-9_+#.-]+$/i.test(name))?.slice("language-".length) ?? "";
}

// Paste a complete header and body as one fenced block, whose language label
// is rendered by the app. A header selected on its own is ordinary text.
function removeDuplicateCodeLabels(body: HTMLElement) {
  for (const label of body.querySelectorAll("[" + CLIPBOARD_CODE_LABEL + "]")) {
    const code = label.nextElementSibling?.matches("pre") ? label.nextElementSibling.firstElementChild : null;
    if (code?.localName === "code" && label.textContent?.trim() === codeLanguage(code)) label.remove();
  }
}

turndownService.addRule("clipboardCodeBlock", {
  filter: (element) => element.localName === "pre" && element.firstElementChild?.localName === "code",
  replacement: (_content, element) => {
    const code = element.firstElementChild;
    if (!code) return "";
    return "\n\n" + formatFencedCode(code.textContent ?? "", codeLanguage(code), true) + "\n\n";
  },
});

turndownService.addRule("styledClipboardText", {
  filter: (element) => !element.closest("pre, code, math") &&
    (SEMANTIC_INLINE_TAGS.has(element.localName) || !!clipboardTextStyle(element)),
  replacement: (content, element) => {
    const style = clipboardTextStyle(element);
    const tag = element.localName;
    const attr = style ? ' style="' + style + '"' : "";
    if (SEMANTIC_INLINE_TAGS.has(tag)) return "<" + tag + attr + ">" + content + "</" + tag + ">";
    const styled = "<span" + attr + ">" + content + "</span>";
    if (tag === "p") return "\n\n" + styled + "\n\n";
    if (tag === "b" || tag === "strong") return "**" + styled + "**";
    if (tag === "i" || tag === "em") return "*" + styled + "*";
    if (tag === "s" || tag === "del") return "~~" + styled + "~~";
    return styled;
  },
});

function clipboardLatex(element: Element): string | undefined {
  return element.closest("pre, code, math") ? undefined : clipboardFormulaMarkdown(element);
}

turndownService.addRule("clipboardLatex", {
  filter: (element) => !!clipboardLatex(element),
  replacement: (_content, element) => {
    const latex = clipboardLatex(element) ?? "";
    return element.localName === "div" ? "\n\n" + latex + "\n\n" : latex;
  },
});

function normalizeClipboardMath(body: HTMLElement): boolean {
  let found = false;
  for (const element of body.querySelectorAll(KATEX_OR_MATHML)) {
    if (!body.contains(element) || element.closest("pre, code, annotation, annotation-xml")) continue;
    const math = copyMath(element, body.ownerDocument);
    if (!math) continue;
    element.replaceWith(math);
    found = true;
  }
  return found;
}

function formatFencedCode(code: string, language: string, preserveTrailingLine = false): string {
  const normalizedCode = code.replace(/\r\n?/g, "\n");
  const longestBacktickRun = (normalizedCode.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${normalizedCode}${!preserveTrailingLine && normalizedCode.endsWith("\n") ? "" : "\n"}${fence}`;
}

function resolveVSCodeCodePaste(clipboardData: DataTransfer): ClipboardMarkdownPaste | null {
  const rawMetadata = clipboardData.getData(VSCODE_EDITOR_DATA_MIME);
  if (!rawMetadata) {
    return null;
  }

  try {
    const metadata: unknown = JSON.parse(rawMetadata);
    if (!isRecord(metadata) || metadata.version !== 1 || typeof metadata.mode !== "string") {
      return null;
    }

    const mode = metadata.mode.trim().toLowerCase();
    const code = clipboardData.getData("text/plain");
    if (!mode || !code || VSCODE_NON_CODE_MODES.has(mode)) {
      return null;
    }

    const safeMode = /^[a-z0-9_+#.-]+$/.test(mode) ? mode : "";
    const language = VSCODE_MARKDOWN_LANGUAGE_ALIASES[safeMode] ?? safeMode;
    return { block: true, markdown: formatFencedCode(code, language) };
  } catch {
    return null;
  }
}

function containsBlockHTML(root: ParentNode): boolean {
  return Boolean(root.querySelector(HTML_BLOCK_SELECTOR));
}

function containsMarkdownFormatting(root: ParentNode): boolean {
  return Boolean(root.querySelector(
    "a[href], b, blockquote, br, code, del, em, h1, h2, h3, h4, h5, h6, hr, i, img[src], ol, pre, s, strike, strong, table, ul, " +
    Array.from(SEMANTIC_INLINE_TAGS).join(", "),
  )) || Array.from(root.querySelectorAll("[style]")).some(clipboardTextStyle);
}

function resolveRichTextMarkdownPaste(clipboardData: DataTransfer): ClipboardMarkdownPaste | null {
  const html = clipboardData.getData("text/html");
  if (!html.trim()) return null;

  const body = new DOMParser().parseFromString(html, "text/html").body;
  removeDuplicateCodeLabels(body);
  // textContent reads literal code (even Markdown punctuation) but ignores
  // HTML line breaks, so turn those into text before the code rule runs.
  for (const lineBreak of body.querySelectorAll("pre > code br")) lineBreak.replaceWith("\n");
  normalizeStyledClipboardLinks(body);
  const hasMath = normalizeClipboardMath(body) || Array.from(body.querySelectorAll(`[${CLIPBOARD_LATEX}]`)).some(clipboardLatex);
  if (!hasMath && !containsMarkdownFormatting(body)) return null;

  // The two representations have different layout (e.g. a fenced block or
  // table can span a different number of lines). Prefer actual rich structure.
  const markdown = turndownService.turndown(body).trim();
  return markdown ? { block: containsBlockHTML(body) || !!body.querySelector('math[display="block"]'), markdown } : null;
}

export function resolveClipboardMarkdownPaste(clipboardData: DataTransfer): ClipboardMarkdownPaste | null {
  if (clipboardData.getData(CODE_BLOCK_PLAIN_TEXT_MIME)) {
    return null;
  }
  if (clipboardData.getData(VSCODE_EDITOR_DATA_MIME)) {
    return resolveVSCodeCodePaste(clipboardData);
  }
  return resolveRichTextMarkdownPaste(clipboardData);
}

export function formatClipboardMarkdownPaste(
  draft: string,
  selectionStart: number,
  selectionEnd: number,
  paste: ClipboardMarkdownPaste,
): { caretIndex: number; value: string } {
  const before = draft.slice(0, selectionStart);
  const after = draft.slice(selectionEnd);
  const leadingBoundary = paste.block && before && !before.endsWith("\n") ? "\n" : "";
  const trailingBoundary = paste.block && after && !after.startsWith("\n") ? "\n" : "";
  const replacement = `${leadingBoundary}${paste.markdown}${trailingBoundary}`;

  return {
    caretIndex: before.length + replacement.length,
    value: `${before}${replacement}${after}`,
  };
}
