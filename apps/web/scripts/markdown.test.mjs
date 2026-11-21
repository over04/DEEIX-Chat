import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { NextIntlClientProvider } from "next-intl";
import React from "react";
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
  'export * from "./shared/components/markdown/markdown-source";',
  'export { normalizeHTMLBlockBlankLines } from "./shared/components/markdown/streamdown-mixed-markup";',
].join("\n"), resolveDir: process.cwd() }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic" });
const { StreamdownRender, listenForMarkdownSelectionCopy, normalizeHTMLBlockBlankLines, registerMarkdownCopyScope, selectedMarkdown, sourceOffsetMap } = await import(pathToFileURL(outfile));

function render(source, props = {}) {
  const translations = new Proxy({}, { get: (_, key) => String(key) });
  const markup = renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", timeZone: "UTC", messages: { chat: { markdown: translations, "markdown.thinking": translations }, common: { actions: translations, errors: translations } },
    onError: (error) => { if (error.code !== "MISSING_MESSAGE") throw error; },
  }, React.createElement(StreamdownRender, { content: source, ...props })));
  return new JSDOM(markup);
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

test("copy takes source slices with style and TeX exactly once", (context) => {
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
  context.after(listenForMarkdownSelectionCopy(owner));
  owner.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(clipboard, { "text/plain": "**乙丙** 和 [链接](https://example.com) $x^2$。\n\n末" });
  const math = owner.querySelector("[data-md-atomic='math']");
  assert.ok(math, owner.body.innerHTML);
  const mathText = math.querySelector(".katex-html").querySelector(".mord").firstChild;
  assert.equal(selectedMarkdown(select(mathText, 0, mathText, 1), owner), "$x^2$");
  const attachment = owner.createElement("p");
  attachment.textContent = "附件名";
  owner.body.appendChild(attachment);
  assert.equal(selectedMarkdown(select(bold, 0, attachment.firstChild, 3), owner), undefined);
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
  assert.equal(selectedMarkdown(select(first, 1, second, 3), owner), "~~~txt\nirst\nsec\n~~~");
});

test("attachment placeholders do not request the Base64 payload", () => {
  const dom = render("正文 ![图片](#deeix-inline-image-pending) ![损坏](#deeix-inline-image-unavailable)");
  const owner = dom.window.document;
  assert.equal(owner.querySelectorAll("[data-streamdown='image-wrapper']").length, 2);
  assert.equal(owner.querySelectorAll("img").length, 0);
  assert.match(owner.body.textContent, /损坏/);
  dom.window.close();
});
