export const CODE_BLOCK_PLAIN_TEXT_MIME = "application/x-deeix-code-block-text";

export type RichClipboardContent = { html?: string; text: string };

function clipboardFormats(content: RichClipboardContent): Record<string, string> {
  return content.html === undefined ? { "text/plain": content.text } : { "text/html": content.html, "text/plain": content.text };
}

export function setRichClipboardData(data: DataTransfer, content: RichClipboardContent) {
  data.clearData();
  for (const [type, value] of Object.entries(clipboardFormats(content))) {
    data.setData(type, value);
  }
}

export async function writeRichClipboard(content: RichClipboardContent): Promise<void> {
  let clipboardError: unknown;
  if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      const formats = Object.entries(clipboardFormats(content)).map(([type, value]) => [type, new Blob([value], { type })]);
      await navigator.clipboard.write([new ClipboardItem(Object.fromEntries(formats))]);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  // In insecure contexts and if the async API rejects (e.g. Permissions-Policy),
  // a native copy event still writes the same two representations together.
  try {
    copyUsingEvent(content.text, content);
  } catch (error) {
    throw clipboardError ?? error;
  }
}

export async function writeClipboardText(value: string): Promise<void> {
  let clipboardError: unknown;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }
  try {
    copyUsingEvent(value);
  } catch (error) {
    throw clipboardError ?? error;
  }
}

function copyUsingEvent(value: string, content?: RichClipboardContent) {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("Clipboard is unavailable");
  }

  const textarea = document.createElement("textarea");
  textarea.value = content && !value ? " " : value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = document.getSelection();
  const selectedRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;

  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  let wroteRichData = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!content || !event.clipboardData) return;
    setRichClipboardData(event.clipboardData, content);
    event.preventDefault();
    wroteRichData = true;
  };
  if (content) document.addEventListener("copy", onCopy, true);
  try {
    const copied = document.execCommand("copy");
    if (!copied || (content && !wroteRichData)) throw new Error("Copy command failed");
  } finally {
    if (content) document.removeEventListener("copy", onCopy, true);
    textarea.remove();
    try {
      activeElement?.focus({ preventScroll: true });
      if (selectedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(selectedRange);
      }
    } catch {
      // Restoring focus or selection must not turn a successful copy into a failed one.
    }
  }
}
