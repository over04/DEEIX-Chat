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
].join("\n"), resolveDir: process.cwd() }, outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic" });
const { StreamdownRender, listenForMarkdownSelectionCopy, registerMarkdownCopyScope, selectedMarkdown, sourceOffsetMap } = await import(pathToFileURL(outfile));

function render(source, props = {}) {
  const translations = new Proxy({}, { get: (_, key) => String(key) });
  const markup = renderToStaticMarkup(React.createElement(NextIntlClientProvider, {
    locale: "en", timeZone: "UTC", messages: { chat: { markdown: translations, "markdown.thinking": translations }, common: { actions: translations, errors: translations } },
    onError: (error) => { if (error.code !== "MISSING_MESSAGE") throw error; },
  }, React.createElement(StreamdownRender, { content: source, ...props })));
  return new JSDOM(markup);
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
