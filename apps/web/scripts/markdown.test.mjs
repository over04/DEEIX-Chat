import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { NextIntlClientProvider } from "next-intl";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after } from "node:test";

// The Next workspace doesn't declare type:module. Bundle its TS/TSX as ESM so
// the tests use the real components and Streamdown's ESM-only dependencies.
await mkdir(join(process.cwd(), ".next"), { recursive: true });
const temporary = await mkdtemp(join(process.cwd(), ".next/markdown-test-"));
after(() => rm(temporary, { recursive: true, force: true }));
const outfile = join(temporary, "entry.mjs");
await build({ stdin: { contents: [
  'export { StreamdownRender } from "./shared/components/markdown/streamdown-render";',
  'export * from "./shared/components/markdown/markdown-selection-copy";',
  'export * from "./shared/components/markdown/markdown-rich-copy";',
  'export { MarkdownMermaidContent } from "./shared/components/markdown/streamdown-mermaid";',
  'export { writeRichClipboard } from "./shared/lib/clipboard";',
  'export { ClipboardImageUnavailable, forgetClipboardObjectImage, prepareClipboardObjectImage } from "./shared/lib/clipboard-image";',
  'export { resolveClipboardMarkdownPaste } from "./features/chat/utils/markdown-paste";',
  'export { AssistantMessageMeta, UserMessageMeta } from "./features/chat/components/message/message-meta";',
  'export { functionPlotDefinition } from "./shared/components/markdown/ui-blocks/function-plot";',
  'export { LiveFormula } from "./shared/components/markdown/ui-blocks/live/live-visuals";',
  'export { LiveBlockContext } from "./shared/components/markdown/ui-blocks/live/live-context";',
  'export * from "./shared/components/markdown/markdown-source";',
  'export { normalizeHTMLBlockBlankLines } from "./shared/components/markdown/streamdown-mixed-markup";',
].join("\n"), resolveDir: process.cwd() }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic" });
const {
  AssistantMessageMeta, ClipboardImageUnavailable, LiveBlockContext, LiveFormula, MarkdownMermaidContent, StreamdownRender, UserMessageMeta,
  forgetClipboardObjectImage, functionPlotDefinition, listenForRichSelectionCopy, messageSelectionSource, normalizeHTMLBlockBlankLines,
  prepareClipboardObjectImage, registerMarkdownCopyScope, renderedRichClipboard, resolveClipboardMarkdownPaste,
  selectedMarkdown, selectionRichClipboard, sourceOffsetMap, writeRichClipboard,
} = await import(pathToFileURL(outfile));

function withTranslations(children) {
  const translations = new Proxy({}, { get: (_, key) => String(key) });
  return React.createElement(NextIntlClientProvider, {
    locale: "en", timeZone: "UTC",
    messages: { chat: { markdown: translations, messages: translations }, common: { actions: translations, errors: translations } },
    onError: (error) => { if (error.code !== "MISSING_MESSAGE") throw error; },
  }, children);
}

function render(source, props = {}) {
  return new JSDOM(renderToStaticMarkup(withTranslations(React.createElement(StreamdownRender, { content: source, ...props }))));
}

function installBrowserGlobals(context, replacements) {
  const previous = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  context.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

function displayedCode(code) {
  // Streamdown paints each source line as a block span. Empty lines use a
  // newline placeholder, so aggregate textContent loses the line boundaries.
  return code.matches("[data-streamdown='code-block-body'] code")
    ? [...code.querySelectorAll(":scope > span")].map((line) => line.textContent.replace(/\n$/, "")).join("\n")
    : code.textContent.trim();
}

function setupSelection(dom) {
  const { window } = dom;
  const previous = globalThis.HTMLElement;
  globalThis.HTMLElement = window.HTMLElement;
  const t = (testContext) => testContext.after(() => { globalThis.HTMLElement = previous; window.close(); });
  function select(start, startOffset, end, endOffset) {
    const range = window.document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection;
  }
  return { owner: window.document, select, t };
}

test("renders multiline display math in typed, streamed and completed messages", () => {
  const source = String.raw`说明
$$\begin{aligned}
a &= b \\
c &= d
\end{aligned}$$

后文；价格 $2 和 $3。

~~~txt
$$not math$$
~~~`;
  for (const props of [{ variant: "user" }, { streaming: true }, {}]) {
    const dom = render(source, props);
    const owner = dom.window.document;
    assert.equal(owner.querySelectorAll(".katex-display").length, 1, owner.body.innerHTML);
    assert.match(owner.body.textContent, /价格 \$2 和 \$3/);
    assert.match(owner.querySelector("[data-streamdown='code-block-body']").textContent, /\$\$not math\$\$/);
    dom.window.close();
  }
});

test("parses Markdown in HTML and XML wrappers and treats code as literal", () => {
  const source = ["<div>", "## 标题", "", "- **强调** 和 [链接](https://example.com/)", "", "<code>**字面文本** $price</code>", "</div>", "", "<response>", "**XML 内容**", "</response>", "", "<doc:note>", "**命名空间内容**", "", "$$", "x + y", "$$", "</doc:note>", "", "<pre><code>**raw** $value</code></pre>", "", "<script>void 0</script>"].join("\n");
  const dom = render(source);
  const owner = dom.window.document;
  assert.equal(owner.querySelector("h2")?.textContent, "标题");
  assert.equal(owner.querySelector("li strong")?.textContent, "强调");
  assert.equal(owner.querySelector("a")?.getAttribute("href"), "https://example.com/");
  assert.equal(owner.querySelector("code")?.textContent, "**字面文本** $price");
  assert.ok([...owner.querySelectorAll("strong")].some((element) => element.textContent === "XML 内容"));
  assert.equal(owner.querySelector("script, response"), null);
  assert.doesNotMatch(owner.body.textContent, /<\/?(?:response|doc:note)>/i);
  assert.ok([...owner.querySelectorAll("strong")].some((element) => element.textContent === "命名空间内容"));
  assert.equal(owner.querySelectorAll(".katex-display").length, 1);
  assert.ok([...owner.querySelectorAll("pre code")].some((element) => element.textContent.trim() === "**raw** $value"),
    [...owner.querySelectorAll("pre, code")].map((element) => element.outerHTML).join("\n"));
  dom.window.close();
});

test("keeps the nested styled HTML cards out of indented code", () => {
  const source = [
    "## 卡片前面的 Markdown",
    "",
    '<div style="display:grid;grid-template-columns:1fr 1fr">',
    '  <div style="padding:12px">',
    '    <div style="font-size:14px"><strong>第一张</strong></div>',
    '    <div style="line-height:1.5">',
    "      一行 <code>示例</code><br/>",
    "      更多 <strong>正文</strong>",
    "    </div>",
    "  </div>",
    '  <div style="padding:16px">',
    '    <div style="font-size:14px"><strong>第二张</strong></div>',
    "  </div>",
    "</div>",
    "",
    "**卡片后面**",
  ].join("\n");
  for (const props of [{}, { streaming: true }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      const grid = owner.querySelector('div[style*="display:grid"]');
      assert.deepEqual([...grid.children].map((child) => child.style.padding), ["12px", "16px"]);
      assert.deepEqual([...grid.querySelectorAll('div[style*="font-size:14px"] strong')].map((label) => label.textContent.trim()), ["第一张", "第二张"]);
      assert.equal(grid.querySelector("code")?.textContent, "示例");
      assert.equal(owner.querySelector("pre"), null);
      assert.equal(owner.querySelector("h2")?.textContent, "卡片前面的 Markdown");
    } finally {
      dom.window.close();
    }
  }
});

const nestedMarkup = [
  "# 外层 Markdown",
  "",
  '> <article style="padding:12px">',
  ">   ## HTML 中的 Markdown",
  ">",
  '>   - 清单 <span style="font-size:16px">_行内_</span>',
  ">",
  ">   <section>",
  ">     ### 深一层",
  ">",
  '>     <div style="border-radius:8px">',
  ">       **甲乙丙** 和 [链接](https://example.com/)",
  ">",
  ">       <div>",
  ">         四层 <em>**混排**</em>",
  ">       </div>",
  ">     </div>",
  ">   </section>",
  "> </article>",
  "",
  "- <div>",
  "    #### 列表里也可以嵌套",
  "",
  "    **下一段**",
  "  </div>",
  "- 后续列表项",
  "",
  "外部结束",
].join("\n");

test("recursively renders Markdown and HTML through nested lists and quotes", () => {
  for (const props of [{}, { streaming: true }, { variant: "user", sourcePositions: true }]) {
    const dom = render(nestedMarkup, props);
    try {
      const owner = dom.window.document;
      assert.equal(owner.querySelector("blockquote article h2")?.textContent, "HTML 中的 Markdown");
      assert.equal(owner.querySelector("article > ul li span > em")?.textContent, "行内");
      assert.equal(owner.querySelector("article section h3")?.textContent, "深一层");
      assert.equal(owner.querySelector("article section div div em strong")?.textContent, "混排");
      assert.equal(owner.querySelector("ul > li > div > h4")?.textContent, "列表里也可以嵌套");
      assert.equal(owner.querySelector("ul > li > div strong")?.textContent, "下一段");
      assert.equal(owner.querySelector("pre"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("renders nested Markdown before streamed HTML has closed", () => {
  const source = nestedMarkup.split("\n>     </div>")[0];
  const dom = render(source, { streaming: true });
  try {
    const owner = dom.window.document;
    assert.equal(owner.querySelector("blockquote article section h3")?.textContent, "深一层");
    assert.equal(owner.querySelector("blockquote article section em strong")?.textContent, "混排");
  } finally {
    dom.window.close();
  }
});

test("keeps fences and HTML code literal inside mixed content", () => {
  const source = [
    "<section>",
    "  ## 边界测试",
    "",
    "  ~~~txt",
    "  </section>",
    "",
    "  **围栏字面**",
    "  ~~~",
    "",
    "      保留缩进代码",
    "",
    "  <pre><code>**HTML 字面**",
    "",
    "    原样缩进",
    "</code></pre>",
    "",
    '  <div onclick="return false">',
    "    **仍在容器** 和 ",
    '    <code title="1 > 0">**行内字面** $value</code >',
    "  </div>",
    "</section>",
  ].join("\n");
  const dom = render(source, { streaming: true });
  try {
    const owner = dom.window.document;
    assert.equal(owner.querySelector("section div strong")?.textContent, "仍在容器");
    assert.equal(owner.querySelector("[onclick]"), null);
    const codes = [...owner.querySelectorAll("section pre code")].map((code) => code.textContent);
    assert.equal(codes.length, 3);
    assert.match(codes[0], /<\/section>\s*\*\*围栏字面\*\*/);
    assert.equal(codes[1].trim(), "保留缩进代码");
    assert.match(codes[2], /\*\*HTML 字面\*\*\s* {4}原样缩进/);
    assert.ok([...owner.querySelectorAll("section code")].some((code) => code.textContent === "**行内字面** $value"));
  } finally {
    dom.window.close();
  }
});

test("preserves indented Markdown code after same-line HTML content", () => {
  const source = "<div>Intro\n\n    const x = 1;\n</div>";
  for (const props of [{}, { streaming: true }, { variant: "user" }]) {
    const dom = render(source, props);
    try {
      const code = dom.window.document.querySelector("pre > code");
      assert.equal(code?.textContent.trim(), "const x = 1;");
    } finally {
      dom.window.close();
    }
  }
});

test("keeps code-only HTML bodies as indented Markdown code", () => {
  const source = [
    "<div>", "    const x = 1;", "</div>", "",
    "<div>", "    <kbd>code sample</kbd>", "</div>", "",
    "<div>", "\tconst y = 2;", "</div>",
  ].join("\n");
  for (const props of [{}, { streaming: true }, { variant: "user", sourcePositions: true }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      assert.deepEqual([...owner.querySelectorAll("pre > code")].map((code) => code.textContent.trim()), [
        "const x = 1;", "<kbd>code sample</kbd>", "const y = 2;",
      ]);
      assert.equal(owner.querySelector("kbd"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("recognizes paired HTML layout blocks indented by four columns", () => {
  const source = [
    "<section>", '    <div style="padding:8px">', "      ## 卡片标题", "",
    "      正文 **强调**", "    </div>", "</section>",
  ].join("\n");
  const dom = render(source, { streaming: true });
  try {
    const owner = dom.window.document;
    const card = owner.querySelector("section > div[style]");
    assert.equal(card?.style.padding, "8px");
    assert.equal(card.querySelector("h2")?.textContent, "卡片标题");
    assert.equal(card.querySelector("strong")?.textContent, "强调");
    assert.equal(owner.querySelector("pre"), null);
  } finally {
    dom.window.close();
  }
});

test("normalizes later display math after unclosed inline HTML code tags", () => {
  const source = String.raw`Use <code> for examples.

\[
a+b
\]

<code>**字面** $price</code>

<section>
Use <kbd> for shortcuts.

\[
c+d
\]
</section>`;
  for (const props of [{}, { streaming: true }, { variant: "user" }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      assert.equal(owner.querySelectorAll(".katex-display").length, 2);
      assert.equal(owner.querySelectorAll("section .katex-display").length, 1);
      assert.ok([...owner.querySelectorAll("code")].some((code) => code.textContent === "**字面** $price"));
    } finally {
      dom.window.close();
    }
  }
});

test("keeps indented HTML-looking Markdown code separate from following math", () => {
  const source = String.raw`    <code>

\[
a+b
\]

<div>
  ## 说明

      <code>

  \[
  c+d
  \]
</div>`;
  for (const props of [{}, { streaming: true }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      assert.deepEqual([...owner.querySelectorAll("pre > code")].map((code) => code.textContent.trim()), ["<code>", "<code>"]);
      assert.equal(owner.querySelectorAll(".katex-display").length, 2);
    } finally {
      dom.window.close();
    }
  }
});

test("keeps HTML literals after a quote, list fence or unpaired backtick", () => {
  const quoteCode = "\\[\na+b\n\\]";
  const listCode = "\\[\nc+d\n\\]";
  const paragraphCode = "\\[\ne+f\n\\] and `";
  const source = [
    "> ~~~txt", "> quoted literal", "", "<pre><code>" + quoteCode + "</code></pre>", "",
    "- ~~~txt", "  list literal", "", "<pre><code>" + listCode + "</code></pre>", "",
    "A lone `", "<pre><code>" + paragraphCode + "</code></pre>",
  ].join("\n");
  for (const props of [{}, { streaming: true }, { variant: "user" }]) {
    const dom = render(source, props);
    try {
      const codes = [...dom.window.document.querySelectorAll("pre > code")].map((code) => code.textContent.trim());
      assert.deepEqual(codes, ["quoted literal", quoteCode, "list literal", listCode, paragraphCode]);
    } finally {
      dom.window.close();
    }
  }
});

test("retains paragraphs inside a card without loosening the surrounding Markdown list", () => {
  const source = [
    "<section>",
    '  - <div style="padding:8px">',
    "      第一段。",
    "",
    "      第二段 **强调**。",
    "    </div>",
    "  - 下一项",
    "</section>",
  ].join("\n");
  for (const props of [{}, { streaming: true }, { variant: "user", sourcePositions: true }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      const card = owner.querySelector("section > ul > li > div[style]");
      assert.deepEqual([...card.querySelectorAll(":scope > p")].map((p) => p.textContent.trim()), ["第一段。", "第二段 强调。"]);
      const next = owner.querySelector("section > ul > li:last-child");
      assert.equal(next.textContent.trim(), "下一项");
      assert.equal(next.querySelector("p"), null);
    } finally {
      dom.window.close();
    }
  }
});

test("does not render multiline HTML comments or use their tags to close containers", () => {
  const source = [
    "<!--", "外层隐藏", "-->", "",
    "<section>", "  <!--", "  内层隐藏", "", "</section>", "  -->",
    "  ### 容器内可见", "</section>", "", "## 外部可见",
  ].join("\n");
  for (const props of [{}, { streaming: true }, { variant: "user" }]) {
    const dom = render(source, props);
    try {
      const owner = dom.window.document;
      assert.doesNotMatch(owner.body.textContent, /隐藏|-->|deeix-md-blank/);
      assert.equal(owner.querySelector("section > h3")?.textContent, "容器内可见");
      assert.equal(owner.querySelector("h2")?.textContent, "外部可见");
    } finally {
      dom.window.close();
    }
  }
});

test("maps partial selections through nested HTML and Markdown indentation", (context) => {
  const dom = render(nestedMarkup);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const scope = owner.querySelector("[data-md-copy-scope]");
  const renderedSource = normalizeHTMLBlockBlankLines(nestedMarkup);
  context.after(registerMarkdownCopyScope(scope, { document: { source: nestedMarkup }, map: renderedSource.offset }));
  const bold = owner.querySelector("section div strong [data-md-text]").firstChild;
  assert.equal(selectedMarkdown(select(bold, 1, bold, 2), owner), "**乙**");
});

test("keeps multiline Markdown code spans with HTML and math verbatim", () => {
  const code = "<code>\n\\[x+y\\]\n</code>";
  const dom = render("Code `" + code + "` end", { streaming: true });
  try {
    const owner = dom.window.document;
    assert.equal(owner.querySelector("code")?.textContent, code.replaceAll("\n", " "));
    assert.equal(owner.querySelector(".katex-display"), null);
  } finally {
    dom.window.close();
  }
});

test("does not add a paragraph break after inline code inside styled HTML in user messages", () => {
  const dom = render('<span style="color:red"><code>x</code> first\nsecond</span>', { variant: "user" });
  try {
    const owner = dom.window.document;
    const container = owner.querySelector('span[style*="color:red"]');
    assert.equal(container?.querySelector("code")?.textContent, "x");
    assert.match(container.textContent, /first\s+second/);
  } finally {
    dom.window.close();
  }
});

test("does not insert HTML blank markers into the next list item's code", () => {
  const source = [
    "- <div>", "  A", "- Next", "", "  ~~~text", "  before", "", "  after", "  ~~~",
  ].join("\n");
  const dom = render(source, { streaming: true });
  try {
    const code = dom.window.document.querySelector("pre > code");
    assert.ok(code);
    assert.equal(displayedCode(code), "before\n\nafter");
  } finally {
    dom.window.close();
  }
});

test("preserves literal processing instructions in HTML and fenced code", () => {
  const oldMarker = "<?deeix-md-blank:0?>";
  const userMarker = "<?deeix-md-blank:0:0?>";
  const source = [
    "<section>", "<pre><code>", oldMarker, "", userMarker, "</code></pre>", "",
    "~~~xml", oldMarker, "", userMarker, "~~~", "</section>",
  ].join("\n");
  const dom = render(source, { streaming: true });
  try {
    const expected = oldMarker + "\n\n" + userMarker;
    assert.deepEqual([...dom.window.document.querySelectorAll("pre > code")].map(displayedCode), [expected, expected]);
  } finally {
    dom.window.close();
  }
});

test("renders a closed widget with blank source lines while the outer HTML streams", () => {
  const source = [
    "<section>", "~~~deeix-widget", "<p>上半部</p>", "", "<p>下半部</p>", "~~~", "</section>",
  ].join("\n");
  const dom = render(source, { streaming: true });
  try {
    const section = dom.window.document.querySelector("section");
    assert.ok(section?.querySelector("button[aria-controls]"));
    assert.equal(section.querySelector('[role="status"]'), null);
  } finally {
    dom.window.close();
  }
});

test("keeps copy positions throughout long quoted HTML", (context) => {
  const count = 500;
  const source = [
    "> <section>", ...Array.from({ length: count }, (_, index) => ">   Line " + index + ": **word" + index + "**"), "> </section>",
  ].join("\n");
  const dom = render(source);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const scope = owner.querySelector("[data-md-copy-scope]");
  context.after(registerMarkdownCopyScope(scope, { document: { source }, map: normalizeHTMLBlockBlankLines(source).offset }));
  const words = owner.querySelectorAll("blockquote section strong [data-md-text]");
  assert.equal(words.length, count);
  const middle = words[count / 2].firstChild;
  assert.equal(selectedMarkdown(select(middle, 1, middle, 4), owner), "**ord**");
});

test("selection copy carries HTML and rendered text, while explicit source retains Markdown and TeX", (context) => {
  const source = "**甲乙丙** 和 [链接](https://example.com) $x^2$。\n\n末尾";
  const dom = render(source);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const scope = owner.querySelector("[data-md-copy-scope]");
  context.after(registerMarkdownCopyScope(scope, { document: { source }, map: sourceOffsetMap(source, source) }));
  const bold = owner.querySelector("strong [data-md-text]").firstChild;
  const link = owner.querySelector("a [data-md-text]").firstChild;
  const end = [...owner.querySelectorAll("[data-md-text]")].at(-1).firstChild;
  assert.equal(selectedMarkdown(select(bold, 1, bold, 2), owner), "**乙**");
  assert.equal(selectedMarkdown(select(link, 0, link, 2), owner), "[链接](https://example.com)");
  select(bold, 1, end, 1);
  let clipboard = { "text/html": "old data" };
  const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    clearData: () => { clipboard = {}; },
    setData: (type, text) => { clipboard[type] = text; },
  } });
  context.after(listenForRichSelectionCopy(owner));
  owner.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(Object.keys(clipboard).sort(), ["text/html", "text/plain"]);
  assert.equal(clipboard["text/plain"], "乙丙 和 链接 $x^2$。\n\n末");
  const pasted = new JSDOM(clipboard["text/html"]);
  context.after(() => pasted.window.close());
  assert.equal(pasted.window.document.querySelector("strong").textContent, "乙丙");
  assert.equal(pasted.window.document.querySelector("a").href, "https://example.com/");
  assert.equal(pasted.window.document.querySelector("[data-deeix-clipboard-latex]").textContent, "$x^2$");
  assert.equal(pasted.window.document.querySelector(".katex-html, annotation, img"), null);
  assert.equal(selectedMarkdown(dom.window.getSelection(), owner), "**乙丙** 和 [链接](https://example.com) $x^2$。\n\n末");
  const math = owner.querySelector("[data-md-atomic='math']");
  assert.ok(math, owner.body.innerHTML);
  const mathIndex = [...math.parentNode.childNodes].indexOf(math);
  assert.equal(selectedMarkdown(select(math.parentNode, mathIndex, math.parentNode, mathIndex + 1), owner), "$x^2$");
  assert.deepEqual(messageSelectionSource(owner.body), { markdown: "$x^2$", latex: "x^2" });
  const attachment = owner.createElement("p");
  attachment.textContent = "附件名";
  owner.body.appendChild(attachment);
  const mixedSelection = select(bold, 0, attachment.firstChild, 3);
  assert.equal(selectedMarkdown(mixedSelection, owner), undefined);
  assert.equal(selectionRichClipboard(mixedSelection, owner), undefined);
});

test("partial code selection preserves fence and selected newlines without line numbers", (context) => {
  const source = "~~~txt\nfirst\nsecond\n~~~\n\n正文";
  const dom = render(source);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const scope = owner.querySelector("[data-md-copy-scope]");
  context.after(registerMarkdownCopyScope(scope, { document: { source }, map: sourceOffsetMap(source, source) }));
  const lines = owner.querySelectorAll("[data-streamdown='code-block-body'] pre > code > span");
  const first = lines[0].querySelector("span").firstChild;
  const second = lines[1].querySelector("span").firstChild;
  const selection = select(first, 1, second, 3);
  assert.equal(selectedMarkdown(selection, owner), "~~~txt\nirst\nsec\n~~~");
  assert.equal(selectionRichClipboard(selection, owner).text, "irst\nsec");
});

const selectionFixture = [
  "2. **刷新当前会话**：用终端运行", "", "   ~~~bash", "   newgrp docker", "     printf '%s' \"$USER\"", "   ~~~", "",
  "   如果失败，请检查 `usermod` 命令。", "", "3. 第二项的后续操作。", "", "列表外的段落。",
].join("\n");

function firstText(element) {
  return element.ownerDocument.createTreeWalker(element, 4).nextNode();
}

function lastText(element) {
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let last;
  while (walker.nextNode()) last = walker.currentNode;
  return last;
}

test("code-only selection in item 2 preserves exact characters without either kind of numbering", (context) => {
  const dom = render(selectionFixture);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const code = owner.querySelector('ol[start="2"] li pre code');
  assert.ok(code, "expected a code block inside item 2");
  const firstLine = code.firstElementChild;
  const start = firstText(firstLine);
  const end = lastText(firstLine);
  const content = selectionRichClipboard(select(start, 0, end, end.length), owner);
  assert.equal(content.text, "newgrp docker");
  assert.match(content.html, /<pre\b.*<code\b[^>]*class="language-bash"/s);
  assert.doesNotMatch(content.html, /<(?:ol|ul|li)\b|data-deeix-code-language|printf/);
  const snippet = selectionRichClipboard(select(end, 1, end, end.length - 1), owner);
  assert.equal(snippet.text, end.data.slice(1, -1));
  const full = selectionRichClipboard(select(code, 0, code, code.childNodes.length), owner);
  assert.equal(full.text, "newgrp docker\n  printf '%s' \"$USER\"");
  assert.deepEqual(full, renderedRichClipboard(code.parentElement));
});

test("mixed selection pastes prose, a separate language label, code, and following prose", (context) => {
  const dom = render(selectionFixture);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const item = owner.querySelector('ol[start="2"] > li');
  const begin = firstText(item.querySelector("strong"));
  const end = lastText(item.querySelector("p:last-of-type"));
  const content = selectionRichClipboard(select(begin, 0, end, end.length), owner);
  assert.equal(content.text, "刷新当前会话：用终端运行\n\nbash\n\nnewgrp docker\n  printf '%s' \"$USER\"\n\n如果失败，请检查 usermod 命令。");
  const pasted = new JSDOM(content.html);
  context.after(() => pasted.window.close());
  const rich = pasted.window.document;
  assert.equal(rich.querySelector("ol, ul, button"), null);
  assert.equal(rich.querySelector("strong").textContent, "刷新当前会话");
  assert.equal(rich.querySelector("[data-deeix-code-language]").textContent, "bash");
  assert.equal(rich.querySelector("pre code").textContent, "newgrp docker\n  printf '%s' \"$USER\"");
  assert.equal(rich.querySelector("p:last-of-type code").textContent, "usermod");
  const composer = resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": content.html, "text/plain": content.text })[type] ?? "" });
  assert.match(composer.markdown, /\u0060{3}bash\nnewgrp docker\n {2}printf/);
  assert.doesNotMatch(composer.markdown, /^bash$/m);
  assert.match(composer.markdown, /\*\*刷新当前会话\*\*/);
  assert.match(composer.markdown, /\u0060usermod\u0060/);
});

test("whole-message copy preserves structure, table styles, code whitespace, and both kinds of math", (context) => {
  const source = [
    "## 标题",
    "",
    String.raw`正文 $\frac{1}{x+1}$ 和 **粗体**。`,
    "",
    "| 列一 | 列二 |",
    "| :--- | ---: |",
    "| 甲 | 乙 |",
    "",
    "$$",
    String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`,
    "$$",
    "",
    "~~~txt",
    "  first",
    "",
    "  second",
    "~~~",
  ].join("\n");
  const dom = render(source);
  context.after(() => dom.window.close());
  const root = dom.window.document.querySelector("[data-chat-markdown-scope]");
  const content = renderedRichClipboard(root);
  const pasted = new JSDOM(content.html);
  context.after(() => pasted.window.close());
  const owner = pasted.window.document;
  assert.equal(owner.querySelector("h2").textContent, "标题");
  assert.equal(owner.querySelector("strong").textContent, "粗体");
  assert.equal(owner.querySelector("table").rows.length, 2);
  assert.equal(owner.querySelector("td").style.borderStyle, "solid");
  assert.equal(owner.querySelectorAll("[data-deeix-clipboard-latex]").length, 2);
  assert.equal(owner.querySelector("p [data-deeix-clipboard-latex]").textContent, String.raw`$\frac{1}{x+1}$`);
  const matrix = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix}`;
  const block = owner.querySelector("div[data-deeix-clipboard-latex]");
  assert.equal(block.getAttribute("data-deeix-clipboard-latex"), matrix);
  assert.equal(block.querySelectorAll("br").length, 2);
  assert.equal(owner.querySelector("pre code").textContent, "  first\n\n  second");
  assert.equal(owner.querySelector("math, annotation, .katex-html, button, img"), null);
  assert.ok(content.text.includes(String.raw`正文 $\frac{1}{x+1}$ 和 粗体。`));
  assert.match(content.text, /列一\t列二\n甲\t乙/);
  assert.ok(content.text.includes(["$$", matrix, "$$"].join("\n")));
  const equation = renderedRichClipboard(root.querySelector(".katex-display"));
  assert.deepEqual(equation, { text: ["$$", matrix, "$$"].join("\n") });
});

test("crossing list items keeps only the item openings in the range and their original numbers", (context) => {
  const dom = new JSDOM('<div data-chat-message-copy-body><ol start="4"><li>未选</li><li><strong>选中</strong><button>不要复制</button><a href="javascript:alert(1)">链接</a><span hidden>隐藏</span></li><li value="9">下一项</li></ol><p>列表外</p></div>');
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const start = owner.querySelector("strong").firstChild;
  const end = owner.querySelector("p").firstChild;
  const content = selectionRichClipboard(select(start, 1, end, 2), owner);
  assert.equal(content.text, "中链接\n\n9. 下一项\n\n列表");
  const pasted = new JSDOM(content.html);
  context.after(() => pasted.window.close());
  assert.equal(pasted.window.document.querySelector("ol").start, 9);
  assert.equal(pasted.window.document.querySelector("ol").textContent, "下一项");
  assert.equal(pasted.window.document.querySelector("strong").textContent, "中");
  assert.doesNotMatch(content.html, /未选|列表外|不要复制|隐藏|javascript/);
  const whole = renderedRichClipboard(owner.querySelector("[data-chat-message-copy-body]"));
  assert.equal(whole.text, "4. 未选\n5. 选中链接\n9. 下一项\n\n列表外");
});

test("selected inline spaces and quote and cell fragments stay in range", (context) => {
  const dom = render(["行内代码： `a   b`", "", "> **引用内容**", "", "| 标题 | 另一个 |", "| --- | --- |", "| abc | def |", "", "$x^2$"].join("\n"));
  const { owner, select, t } = setupSelection(dom);
  t(context);
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const inlineCode = owner.querySelector("code");
  const inline = firstText(inlineCode);
  const inlineCopy = selectionRichClipboard(select(inline, 0, inline, inline.length), owner);
  assert.equal(inlineCopy.text, "a   b");
  assert.deepEqual(inlineCopy, renderedRichClipboard(inlineCode));
  const quote = firstText(owner.querySelector("blockquote strong"));
  const quoted = selectionRichClipboard(select(quote, 1, quote, 3), owner);
  assert.equal(quoted.text, "用内");
  assert.match(quoted.html, /<strong[^>]*>用内<\/strong>/);
  assert.doesNotMatch(quoted.html, /<blockquote|<p\b/);
  const paste = resolveClipboardMarkdownPaste({ getData: (type) => type === "text/html" ? quoted.html : "" });
  assert.equal(paste.block, false);
  assert.equal(paste.markdown, "**用内**");
  const cell = firstText(owner.querySelector("td"));
  const oneCell = selectionRichClipboard(select(cell, 0, cell, 2), owner);
  assert.equal(oneCell.text, "ab");
  assert.doesNotMatch(oneCell.html, /<table|<td/);
  const otherCell = firstText(owner.querySelector("td:last-child"));
  const cells = selectionRichClipboard(select(cell, 1, otherCell, 2), owner);
  assert.equal(cells.text, "bc\tde");
  assert.match(cells.html, /<table/);
});

test("the live selection snaps to formula boundaries and keeps the drag direction", (context) => {
  const dom = render("正文之前\n\n$$\nx^2+1\n$$\n\n正文之后");
  const { owner, t } = setupSelection(dom);
  t(context);
  context.after(listenForRichSelectionCopy(owner));
  const display = owner.querySelector(".katex-display");
  const formula = display.closest("[data-md-atomic='math']") ?? display;
  const start = firstText(owner.querySelector("p"));
  const visual = firstText(formula.querySelector(".katex-html"));
  const selection = owner.getSelection();
  const parent = formula.parentNode;
  const index = [...parent.childNodes].indexOf(formula);
  // Chrome can report a KaTeX descendant as a drag endpoint even with user-select: all.
  selection.setBaseAndExtent(visual, 0, start, 1);
  owner.dispatchEvent(new dom.window.Event("selectionchange"));
  assert.equal(selection.anchorNode, parent);
  assert.equal(selection.anchorOffset, index + 1);
  assert.equal(selection.focusNode, start);
  assert.equal(selection.focusOffset, 1);
  selection.setBaseAndExtent(start, 1, visual, 1);
  owner.dispatchEvent(new dom.window.Event("selectionchange"));
  assert.equal(selection.anchorNode, start);
  assert.equal(selection.anchorOffset, 1);
  assert.equal(selection.focusNode, parent);
  assert.equal(selection.focusOffset, index + 1);
});

test("selecting a formula block copies complete LaTeX as plain text", (context) => {
  const source = String.raw`\bar{X}_n=\frac{1}{n}\sum_{i=1}^n X_i`;
  const dom = render(["正文开始", "", "$$", source, "$$", "", "正文结束"].join("\n"));
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const formula = owner.querySelector(".katex-display");
  const parent = formula.parentNode;
  const index = [...parent.childNodes].indexOf(formula);
  const expected = ["$$", source, "$$"].join("\n");

  select(parent, index, parent, index + 1);
  const formats = new Map([["text/html", "old data"]]);
  context.after(listenForRichSelectionCopy(owner));
  const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    clearData: () => formats.clear(),
    setData: (type, value) => formats.set(type, value),
  } });
  owner.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual([...formats], [["text/plain", expected]]);

  const paragraphs = owner.querySelectorAll("[data-chat-markdown-scope] p");
  const start = firstText(paragraphs[0]);
  const next = firstText(paragraphs[1]);
  assert.deepEqual(selectionRichClipboard(select(start, 2, start, start.length), owner), { html: "<span>开始</span>", text: "开始" });
  const content = selectionRichClipboard(select(start, 2, parent, index + 1), owner);
  assert.equal(content.text, "开始\n\n" + expected);
  assert.doesNotMatch(content.html, /<math\b|katex/);
  const imported = new JSDOM(content.html);
  context.after(() => imported.window.close());
  const html = imported.window.document.querySelector("[data-deeix-clipboard-latex]");
  assert.equal(html.getAttribute("data-deeix-clipboard-latex"), source);
  assert.deepEqual([...html.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent), ["$$", source, "$$"]);
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  assert.deepEqual(resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": content.html, "text/plain": content.text })[type] ?? "" }), {
    block: true, markdown: "开始\n\n" + expected,
  });
  assert.equal(selectionRichClipboard(select(start, 2, next, next.length), owner).text, "开始\n\n" + expected + "\n\n正文结束");
});

test("selecting linked code keeps its link and formatted paste keeps hard breaks", (context) => {
  const dom = new JSDOM('<article data-chat-message-copy-body><p><strong><a href="https://example.test/"><code>a   b</code></a></strong><br>下一行</p></article>');
  const { owner, select, t } = setupSelection(dom);
  t(context);
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const code = owner.querySelector("code").firstChild;
  const selected = selectionRichClipboard(select(code, 0, code, code.length), owner);
  assert.equal(selected.text, "a   b");
  const output = new JSDOM(selected.html);
  context.after(() => output.window.close());
  assert.equal(output.window.document.querySelector("strong a code").textContent, "a   b");
  assert.equal(output.window.document.querySelector("a").href, "https://example.test/");
  const paste = resolveClipboardMarkdownPaste({ getData: (type) => type === "text/html" ? "<p>甲<br>乙</p>" : "" });
  const preview = render(paste.markdown);
  context.after(() => preview.window.close());
  assert.ok(preview.window.document.querySelector("p br"));
});

test("copying structure does not remove blank columns or renumber after an empty list item", (context) => {
  const dom = new JSDOM('<article data-chat-message-copy-body><table><tbody><tr><td>A</td><td></td><td>C</td></tr></tbody></table><ol start="2"><li>前</li><li></li><li>后</li></ol></article>');
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const root = owner.querySelector("article");
  const cells = root.querySelectorAll("td");
  const selection = selectionRichClipboard(select(cells[0].firstChild, 0, cells[2].firstChild, 1), owner);
  assert.equal(selection.text, "A\t\tC");
  const all = renderedRichClipboard(root);
  assert.equal(all.text, "A\t\tC\n\n2. 前\n3. \n4. 后");
  const output = new JSDOM(all.html);
  context.after(() => output.window.close());
  assert.equal(output.window.document.querySelectorAll("td").length, 3);
  assert.equal(output.window.document.querySelectorAll("li").length, 3);
});

test("resolved colors survive copying and safe highlights survive pasting to the composer", (context) => {
  const dom = new JSDOM('<style>code { color: #732116; background-color: #ffefd4 }</style><div data-chat-markdown-scope><p><span style="color:#663c00;background-color:#fde68a">高亮文字</span> <code>foo</code></p></div>');
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const content = renderedRichClipboard(dom.window.document.querySelector("[data-chat-markdown-scope]"));
  const pasted = new JSDOM(content.html);
  context.after(() => pasted.window.close());
  const code = pasted.window.document.querySelector("code");
  assert.equal(code.style.color, "rgb(115, 33, 22)");
  assert.equal(code.style.backgroundColor, "rgb(255, 239, 212)");
  const markdown = resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": content.html, "text/plain": content.text })[type] ?? "" }).markdown;
  const rendered = render(markdown);
  context.after(() => rendered.window.close());
  const highlight = rendered.window.document.querySelector('span[style*="background-color"]');
  assert.equal(highlight.textContent, "高亮文字");
  assert.equal(highlight.style.backgroundColor, "rgb(253, 230, 138)");
});

test("portable clipboard images render after pasting and unsafe SVG is rejected", (context) => {
  const bitmap = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=";
  const dom = new JSDOM(`<div data-chat-message-copy-body><img src="${bitmap}" alt="attached bitmap"><div data-streamdown="mermaid"><div role="img" aria-label="graph"><svg width="100" height="50"><defs><clipPath id="plot"><rect width="100" height="50"/></clipPath></defs><g clip-path="url(#plot)"><path d="M1 1 L10 10" stroke="#443322"/><text>plot (x) &amp; y</text></g></svg></div></div></div>`);
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const content = renderedRichClipboard(dom.window.document.querySelector("[data-chat-message-copy-body]"));
  const pasted = resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": content.html, "text/plain": content.text })[type] ?? "" });
  const preview = render(pasted.markdown);
  context.after(() => preview.window.close());
  const images = preview.window.document.images;
  assert.equal(images.length, 2);
  assert.equal(images[0].getAttribute("src"), bitmap);
  const graph = decodeURIComponent(images[1].getAttribute("src").split(",")[1]);
  assert.match(graph, /clip-path="url\(#plot\)"/);
  assert.match(graph, /plot \(x\) &amp; y/);
  assert.equal(renderedRichClipboard(preview.window.document.querySelector("[data-chat-markdown-scope]")).text.includes("plot (x) & y"), true);

  const reject = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/image.svg"/></svg>')}`;
  const unsafe = render(`![blocked](${reject})\n\n[blocked](data:text/html;base64,WA==)`);
  context.after(() => unsafe.window.close());
  assert.equal(unsafe.window.document.querySelector('img[src^="data:"],a[href^="data:"]'), null);
});

test("pasting styled text preserves literal angle brackets and dollar signs", (context) => {
  const dom = new JSDOM('<p><span style="color: #782137; font-weight: 700">a &lt;b&gt; &amp; $x$</span></p>');
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const html = dom.window.document.body.innerHTML;
  const pasted = resolveClipboardMarkdownPaste({ getData: (type) => type === "text/html" ? html : "" });
  const preview = render(pasted.markdown);
  context.after(() => preview.window.close());
  const span = preview.window.document.querySelector('span[style*="font-weight"]');
  assert.equal(span.textContent, "a <b> & $x$");
  assert.equal(span.querySelector("b, math"), null);
});

test("message copy and a selection spanning a sandbox frame retain the surrounding text", (context) => {
  const dom = new JSDOM('<article data-chat-message-copy-body><p>Before</p><iframe sandbox="allow-scripts" data-ui-block-id="widget" srcdoc="Widget contents"></iframe><p>After</p></article>');
  const { owner, select, t } = setupSelection(dom);
  t(context);
  const body = owner.querySelector("article");
  const whole = renderedRichClipboard(body);
  assert.equal(whole.text, "Before\n\nAfter");
  assert.doesNotMatch(whole.html, /iframe|Widget contents/);

  const paragraphs = body.querySelectorAll("p");
  select(paragraphs[0].firstChild, 2, paragraphs[1].firstChild, 3);
  const formats = new Map();
  const errors = [];
  context.after(listenForRichSelectionCopy(owner, (error) => errors.push(error)));
  const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: {
    clearData: () => formats.clear(),
    setData: (type, value) => formats.set(type, value),
  } });
  body.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(formats.get("text/plain"), "fore\n\nAft");
  assert.doesNotMatch(formats.get("text/html"), /iframe|Widget contents/);
  assert.deepEqual(errors, []);
});

test("pasting external HTML code preserves breaks, blank lines, and indentation", (context) => {
  const dom = new JSDOM();
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const formats = {
    "text/html": '<pre><code class="language-text"><span>line1</span><br><br><span>  line3</span><br>&lt;line4&gt;<br>line5</code></pre>',
    "text/plain": "line1\n\n  line3\n<line4>\nline5",
  };
  const pasted = resolveClipboardMarkdownPaste({ getData: (type) => formats[type] ?? "" });
  const fence = "\u0060".repeat(3);
  assert.deepEqual(pasted, { block: true, markdown: fence + "text\n" + formats["text/plain"] + "\n" + fence });
});

test("styled links keep relative and parenthesized destinations and their titles", (context) => {
  const dom = new JSDOM();
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const html = '<a href="/docs/start" title="Start here" style="color:#732116">Start</a> ' +
    '<a href="https://example.test/docs/Function_(code)" style="color:#732116">Function</a>';
  const { markdown } = resolveClipboardMarkdownPaste({ getData: (type) => type === "text/html" ? html : "" });
  const preview = render(markdown);
  context.after(() => preview.window.close());
  const links = Array.from(preview.window.document.querySelectorAll("a[href]"));
  assert.deepEqual(links.map((link) => link.getAttribute("href")), ["/docs/start", "https://example.test/docs/Function_(code)"]);
  assert.equal(links[0].title, "Start here");
  assert.equal(links[0].querySelector("span[style]").style.color, "rgb(115, 33, 22)");
});

test("plain-text nested lists retain their depth without adding indentation to code", (context) => {
  const dom = new JSDOM('<article><ol start="10"><li>Main<ul><li>Child<ol><li>Leaf</li></ol><pre><code>one\n  two</code></pre></li></ul></li><li>Next</li></ol></article>');
  context.after(() => dom.window.close());
  const { text } = renderedRichClipboard(dom.window.document.querySelector("article"));
  assert.equal(text, "10. Main\n\n    • Child\n\n      1. Leaf\n\none\n  two\n11. Next");
});

test("code toolbar writes the trailing blank lines in both clipboard formats", async (context) => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const app = createRoot(window.document.getElementById("app"));
  const writes = [];
  context.after(async () => { await React.act(() => app.unmount()); window.close(); });
  installBrowserGlobals(context, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    ClipboardItem: class { constructor(formats) { this.formats = formats; } },
    navigator: { clipboard: { write: async (items) => writes.push(items) } },
  });
  await React.act(() => app.render(withTranslations(React.createElement(StreamdownRender, { content: "~~~text\none\n\n\n~~~" }))));
  const button = window.document.querySelector("[data-streamdown='code-block-actions'] button");
  assert.ok(button);
  await React.act(async () => button.click());
  assert.equal(writes.length, 1);
  const { formats } = writes[0][0];
  assert.equal(await formats["text/plain"].text(), "one\n\n");
  const html = new window.DOMParser().parseFromString(await formats["text/html"].text(), "text/html");
  assert.equal(html.querySelector("pre > code").textContent, "one\n\n");
});

test("Mermaid copy uses the source button when the visible SVG cannot be exported", async (context) => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const app = createRoot(window.document.getElementById("app"));
  const richWrites = [];
  const sourceWrites = [];
  context.after(async () => { await React.act(() => app.unmount()); window.close(); });
  installBrowserGlobals(context, {
    window, document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
    ClipboardItem: class { constructor(formats) { this.formats = formats; } },
    navigator: { clipboard: { write: async (items) => richWrites.push(items), writeText: async (text) => sourceWrites.push(text) } },
  });
  const h = React.createElement;
  const chart = "venn-beta\n  set A";
  function diagram(canExport) {
    return h(MarkdownMermaidContent, null,
      h("div", { "data-streamdown": "mermaid" },
        h("div", { "data-streamdown": "mermaid-block-actions" },
          h("button", { "data-streamdown": "code-block-copy-button", onClick: () => navigator.clipboard.writeText(chart) }, "Copy")),
        h("div", { role: "img" }, h("svg", { width: 100, height: 50 }, canExport
          ? h("text", null, "A")
          : h("foreignObject", { width: 100, height: 50 }, h("div", null, "A"))))));
  }
  await React.act(() => app.render(withTranslations(diagram(false))));
  await React.act(async () => window.document.querySelector("button").click());
  assert.deepEqual(sourceWrites, [chart]);
  assert.equal(richWrites.length, 0);
  await React.act(() => app.render(withTranslations(diagram(true))));
  await React.act(async () => window.document.querySelector("button").click());
  assert.equal(sourceWrites.length, 1);
  assert.equal(richWrites.length, 1);
  assert.match(await richWrites[0][0].formats["text/html"].text(), /<img[^>]+data:image\/svg/);
});

test("toolbar write makes one clipboard item with both representations", async (context) => {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const clipboardItem = Object.getOwnPropertyDescriptor(globalThis, "ClipboardItem");
  const writes = [];
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: class {
    constructor(formats) { this.formats = formats; }
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
    write: async (items) => writes.push(items),
    writeText: () => assert.fail("rich copy must not use a separate plain-text write"),
  } } });
  context.after(() => {
    if (navigator) Object.defineProperty(globalThis, "navigator", navigator);
    else delete globalThis.navigator;
    if (clipboardItem) Object.defineProperty(globalThis, "ClipboardItem", clipboardItem);
    else delete globalThis.ClipboardItem;
  });
  await writeRichClipboard({ html: "<h1>标题</h1>", text: "标题" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  const { formats } = writes[0][0];
  assert.deepEqual(Object.keys(formats).sort(), ["text/html", "text/plain"]);
  assert.equal(await formats["text/html"].text(), "<h1>标题</h1>");
  assert.equal(await formats["text/plain"].text(), "标题");
});

test("denied async clipboard writes use a native copy event with the same two formats", async (context) => {
  const dom = new JSDOM('<button autofocus>Copy</button><p>Selected</p>');
  context.after(() => dom.window.close());
  let asyncWrites = 0;
  installBrowserGlobals(context, {
    navigator: { clipboard: { write: async () => { asyncWrites += 1; throw new DOMException("Clipboard denied", "NotAllowedError"); } } },
    ClipboardItem: class {},
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
  });
  const owner = dom.window.document;
  const button = owner.querySelector("button");
  button.focus();
  const selection = owner.getSelection();
  const range = owner.createRange();
  range.selectNodeContents(owner.querySelector("p"));
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(selection.toString(), "Selected");
  const formats = new Map();
  let commands = 0;
  owner.execCommand = (command) => {
    ++commands;
    assert.equal(command, "copy");
    const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      clearData: () => formats.clear(),
      setData: (type, value) => formats.set(type, value),
    } });
    owner.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  };
  await writeRichClipboard({ html: "<strong>Selected</strong>", text: "Selected" });
  assert.equal(asyncWrites, 1);
  assert.equal(commands, 1);
  assert.deepEqual(Object.fromEntries(formats), { "text/html": "<strong>Selected</strong>", "text/plain": "Selected" });
  assert.equal(owner.querySelector("textarea"), null);
  assert.equal(owner.activeElement, button);
  assert.equal(selection.toString(), "Selected");
});

test("clipboard serializes task-list state without copying a form control", (context) => {
  const dom = render("- [x] 已完成\n- [ ] 待办");
  context.after(() => dom.window.close());
  const content = renderedRichClipboard(dom.window.document.querySelector("[data-chat-markdown-scope]"));
  assert.match(content.html, /☑.*已完成/s);
  assert.match(content.html, /☐.*待办/s);
  assert.doesNotMatch(content.html, /<input/);
});

test("copying the reported bold sentence pastes clean Markdown in the composer", (context) => {
  const source = "要理解为什么不需要独立，只需看一眼该定理的证明核心。切比雪夫大数定律的证明完全建立在**切比雪夫不等式**和**方差的性质**之上：";
  const dom = render(source);
  const { owner, select, t } = setupSelection(dom);
  t(context);
  installBrowserGlobals(context, { DOMParser: dom.window.DOMParser });
  const p = owner.querySelector("[data-chat-markdown-scope] p");
  // JSDOM does not compute the --font-chat-strong-weight CSS variable.
  for (const bold of p.querySelectorAll("strong")) bold.style.fontWeight = "700";
  const first = firstText(p);
  const last = lastText(p);
  const clip = selectionRichClipboard(select(first, 0, last, last.length), owner);
  assert.match(clip.html, /<strong style="[^"]*font-weight: 700;/);
  assert.equal(resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": clip.html, "text/plain": clip.text })[type] ?? "" }).markdown, source);
});

test("copy and paste keep math structure and Markdown formatting in the composer", (context) => {
  const original = render("See **equation** $x^{a+b}+\\frac{2}{3}$ then $\\text{*bold* [note] | path}$.");
  context.after(() => original.window.close());
  installBrowserGlobals(context, { DOMParser: original.window.DOMParser });
  const clip = renderedRichClipboard(original.window.document.querySelector("[data-chat-markdown-scope]"));
  assert.ok(clip.text.includes(String.raw`equation $x^{a+b}+\frac{2}{3}$`));
  const result = resolveClipboardMarkdownPaste({ getData: (type) => ({ "text/html": clip.html, "text/plain": clip.text })[type] ?? "" });
  assert.ok(result.markdown.includes(String.raw`**equation** $x^{a+b}+\frac{2}{3}$`));
  const pasted = render(result.markdown, { variant: "user" });
  context.after(() => pasted.window.close());
  const owner = pasted.window.document;
  assert.equal(owner.querySelector("strong").textContent, "equation");
  assert.equal(owner.querySelector("math msup > mrow").textContent, "a+b");
  assert.equal(owner.querySelector("math mfrac > mn:last-child").textContent, "3");
  const originallyRenderedMathText = original.window.document.querySelectorAll("math")[1].querySelector("semantics").firstElementChild.textContent;
  assert.equal(owner.querySelectorAll("math")[1].querySelector("semantics").firstElementChild.textContent, originallyRenderedMathText);
  assert.match(originallyRenderedMathText, /\*bold\*\s+\[note\]/);
  assert.equal(owner.querySelector("math mtext strong, math span, math img"), null);

  const html = '<math display="block" onclick="alert(1)"><semantics><mfrac><mi>x</mi><mi>y</mi></mfrac><annotation-xml><svg onload="alert(1)"></svg></annotation-xml></semantics></math>';
  const display = resolveClipboardMarkdownPaste({ getData: (type) => type === "text/html" ? html : "" });
  assert.equal(display.block, true);
  assert.match(display.markdown, /<math[^>]+display="block"[^>]*><mfrac>/);
  assert.doesNotMatch(display.markdown, /onclick|annotation-xml|<svg/);
});

test("pure text distinguishes structural fraction operands and exponent bases", (context) => {
  const dom = new JSDOM('<article><p><math><mfrac><mi>a</mi><mrow><mi>b</mi><mi>c</mi></mrow></mfrac><mo>+</mo><mfrac><mi>a</mi><mi>b</mi></mfrac><mi>c</mi></math></p><p><math><msup><mrow><mi>a</mi><mi>b</mi></mrow><mn>2</mn></msup><mo>+</mo><mi>a</mi><msup><mi>b</mi><mn>2</mn></msup></math></p></article>');
  context.after(() => dom.window.close());
  const clip = renderedRichClipboard(dom.window.document.querySelector("article"));
  assert.equal(clip.text, "a/(bc)+(a/b)c\n\n(ab)²+ab²");
});

test("generated images are embedded and a missing blob does not copy just its label", async (context) => {
  const url = "blob:https://deeix.example/generated";
  const dom = new JSDOM('<div data-chat-message-copy-body><img src="' + url + '" alt="Generated Image"></div>');
  context.after(() => dom.window.close());
  installBrowserGlobals(context, { FileReader: dom.window.FileReader });
  const owner = dom.window.document;
  const imageOnly = owner.querySelector("[data-chat-message-copy-body]");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=";
  const bytes = new dom.window.Blob([Buffer.from(png, "base64")], { type: "image/png" });
  await prepareClipboardObjectImage(url, bytes, new AbortController().signal);
  context.after(() => forgetClipboardObjectImage(url));
  const range = owner.createRange();
  range.selectNodeContents(imageOnly);
  const selection = owner.getSelection();
  selection.addRange(range);
  const whole = renderedRichClipboard(imageOnly);
  assert.match(whole.html, /<img src="data:image\/png;base64,/);
  assert.ok(whole.html.includes(png));
  assert.doesNotMatch(whole.html, /blob:|deeix\.example/);
  assert.equal(whole.text, "Generated Image");
  assert.deepEqual(selectionRichClipboard(selection, owner), whole);

  forgetClipboardObjectImage(url);
  assert.throws(() => renderedRichClipboard(imageOnly), ClipboardImageUnavailable);
  const errors = [];
  context.after(listenForRichSelectionCopy(owner, (error) => errors.push(error)));
  const event = new dom.window.Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { clearData: () => assert.fail("Do not write partial data") } });
  imageOnly.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.ok(errors[0] instanceof ClipboardImageUnavailable);
});

test("public messages and independent previews expose a Markdown source menu", (context) => {
  const source = "**Read-only Markdown** and $x^2$";
  const preview = render(source);
  const { owner, select, t } = setupSelection(preview);
  t(context);
  const root = owner.querySelector("[data-chat-markdown-scope]");
  const scope = root.querySelector("[data-md-copy-scope]");
  context.after(registerMarkdownCopyScope(scope, { document: { source }, map: sourceOffsetMap(source, source) }));
  assert.ok(root.querySelector('button[aria-haspopup="menu"]'));
  const bold = root.querySelector("strong [data-md-text]").firstChild;
  select(bold, 0, bold, 9);
  assert.equal(messageSelectionSource(root).markdown, "**Read-only**");
  const equation = root.querySelector(".katex");
  const equationIndex = [...equation.parentNode.childNodes].indexOf(equation);
  select(equation.parentNode, equationIndex, equation.parentNode, equationIndex + 1);
  assert.equal(messageSelectionSource(root).latex, "x^2");
  const messages = [UserMessageMeta, AssistantMessageMeta].map((Component) => React.createElement(Component, {
    key: Component.name,
    item: { publicID: "public-item", content: "$x^2$" },
    copyBodyRef: { current: null },
    readOnly: true,
    alwaysVisible: true,
  }));
  const share = new JSDOM(renderToStaticMarkup(withTranslations(messages)));
  context.after(() => share.window.close());
  assert.equal(share.window.document.querySelectorAll('button[aria-haspopup="menu"]').length, 2);
  assert.equal(share.window.document.querySelectorAll('button').length, 4);
});

test("real plot markup copies equations and curves; live formulas remain keyboard-copyable after updates", async (context) => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  const owner = window.document;
  const node = owner.getElementById("app");
  const app = createRoot(node);
  const writes = [];
  // Unmount before the globals are restored so React can clear its timers.
  context.after(async () => { await React.act(() => app.unmount()); window.close(); });
  installBrowserGlobals(context, {
    window, document: owner, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { observe() {} disconnect() {} },
    ClipboardItem: class { constructor(formats) { this.formats = formats; } },
    navigator: { clipboard: { write: async (items) => writes.push(items) } },
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", { get: () => 330 });
  function sample(value) {
    return withTranslations(React.createElement("div", { "data-chat-markdown-scope": "" },
      React.createElement(functionPlotDefinition.Component, { id: "test-plot", props: { title: "Two curves", functions: [{ expr: "y=x^2" }, { expr: "y=sin(x)" }] } }),
      React.createElement(LiveBlockContext.Provider, { value: { values: { m: value } } },
        React.createElement(LiveFormula, { node: { props: { expr: "m*2", with: ["m"] } } }))));
  }
  await React.act(() => app.render(sample(3)));
  const body = owner.querySelector("[data-chat-markdown-scope]");
  const content = renderedRichClipboard(body);
  const pasted = new JSDOM(content.html);
  context.after(() => pasted.window.close());
  const pastedDocument = pasted.window.document;
  assert.equal(pastedDocument.querySelectorAll("li [data-deeix-clipboard-latex]").length, 2);
  assert.equal(pastedDocument.querySelector("button, input"), null);
  const image = pastedDocument.querySelector("img[alt='Two curves']");
  assert.match(image.src, /^data:image\/svg\+xml/);
  const svg = new window.DOMParser().parseFromString(decodeURIComponent(image.src.split(",").slice(1).join(",")), "image/svg+xml");
  assert.equal(svg.querySelectorAll("path[stroke]").length, 2);

  const formulaTargets = body.querySelectorAll('[data-clipboard-formula="block"]');
  assert.equal(formulaTargets.length, 2);
  const worked = formulaTargets[1];
  const before = worked.querySelector("math").textContent;
  worked.focus();
  await React.act(() => app.render(sample(7)));
  assert.equal(owner.activeElement, worked);
  assert.equal(worked.getAttribute("tabindex"), "0");
  assert.notEqual(worked.querySelector("math").textContent, before);
  await React.act(async () => worked.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.equal(writes.length, 1);
  assert.deepEqual(Object.keys(writes[0][0].formats), ["text/plain"]);
  const latestSource = worked.querySelector('annotation[encoding="application/x-tex"]').textContent;
  assert.match(latestSource, /14/);
  assert.equal(await writes[0][0].formats["text/plain"].text(), ["$$", latestSource, "$$"].join("\n"));
});

test("attachment placeholders do not request the Base64 payload", () => {
  const dom = render("正文 ![图片](#deeix-inline-image-pending) ![损坏](#deeix-inline-image-unavailable)");
  const owner = dom.window.document;
  assert.equal(owner.querySelectorAll("[data-streamdown='image-wrapper']").length, 2);
  assert.equal(owner.querySelectorAll("img").length, 0);
  assert.match(owner.body.textContent, /损坏/);
  assert.throws(() => renderedRichClipboard(owner.querySelector("[data-chat-markdown-scope]")), ClipboardImageUnavailable);
  dom.window.close();
});
