"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { KATEX_OR_MATHML } from "./clipboard-math";
import { useRenderedCopy } from "./use-rendered-copy";

const COPYABLE_CODE = "code:not(pre code)";
const INTERACTIVE = "a, button, input, textarea, select, summary, [contenteditable='true']";
const DRAG_THRESHOLD = 6;

type UseMarkdownCopyOptions = { contentVersion: string; renderVersion: unknown };
type MarkdownCopyTarget = { kind: "formula" | "code"; element: Element };

function asElement(target: EventTarget | null) {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

function outerFormula(element: Element) {
  return element.closest(".katex-display") ?? element.closest(".katex") ?? element.closest("math");
}

function resolveCopyTarget(target: EventTarget | null, root: HTMLElement): MarkdownCopyTarget | null {
  const element = asElement(target);
  if (!element || !root.contains(element) || element.closest(INTERACTIVE + ", [data-clipboard-formula]")) return null;
  const code = element.closest("[data-inline-code-copyable='true']");
  if (code?.textContent?.trim()) return { kind: "code", element: code };
  if (element.closest("pre, code")) return null;
  const formula = outerFormula(element);
  return formula && root.contains(formula) && (formula.matches("math") || formula.querySelector("math"))
    ? { kind: "formula", element: formula } : null;
}

function annotate(element: Element, attribute: string, label: string) {
  element.setAttribute(attribute, "true");
  element.setAttribute("tabindex", "0");
  element.setAttribute("role", "button");
  element.setAttribute("aria-label", label);
  element.setAttribute("title", label);
}

export function useMarkdownCopy({ contentVersion, renderVersion }: UseMarkdownCopyOptions) {
  const t = useTranslations("chat.markdown");
  const commonActions = useTranslations("common.actions");
  const commonErrors = useTranslations("common.errors");
  const { copyRendered } = useRenderedCopy({ copied: t("formulaCopied"), failed: t("formulaCopyFailed") });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const pointerDownRef = React.useRef<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const formulas = new Set<Element>();
    for (const child of root.querySelectorAll(KATEX_OR_MATHML)) {
      const formula = outerFormula(child);
      if (formula && !formula.closest(INTERACTIVE + ", pre, code, [data-clipboard-formula]") && (formula.matches("math") || formula.querySelector("math"))) formulas.add(formula);
    }
    for (const formula of formulas) annotate(formula, "data-formula-copyable", t("copyFormula"));
    for (const code of root.querySelectorAll(COPYABLE_CODE)) {
      if (code.textContent?.trim() && !code.closest(INTERACTIVE)) annotate(code, "data-inline-code-copyable", commonActions("copy"));
    }
  }, [commonActions, contentVersion, renderVersion, t]);

  const copyMarkdownTarget = React.useCallback((target: MarkdownCopyTarget) => {
    if (target.kind === "code") {
      return copyRendered(target.element, { copied: commonActions("copied"), failed: commonErrors("copyFailed") });
    }
    return copyRendered(target.element);
  }, [commonActions, commonErrors, copyRendered]);

  const onPointerDownCapture = React.useCallback<React.PointerEventHandler<HTMLDivElement>>((event) => {
    pointerDownRef.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
  }, []);

  const onClickCapture = React.useCallback<React.MouseEventHandler<HTMLDivElement>>((event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const down = pointerDownRef.current;
    if (down && (Math.abs(event.clientX - down.x) > DRAG_THRESHOLD || Math.abs(event.clientY - down.y) > DRAG_THRESHOLD)) return;
    const root = rootRef.current;
    const selection = root?.ownerDocument.getSelection();
    if (!root || (selection && !selection.isCollapsed)) return;
    const target = resolveCopyTarget(event.target, root);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void copyMarkdownTarget(target);
  }, [copyMarkdownTarget]);

  const onKeyDownCapture = React.useCallback<React.KeyboardEventHandler<HTMLDivElement>>((event) => {
    if (event.defaultPrevented || (event.key !== "Enter" && event.key !== " ")) return;
    const element = asElement(event.target);
    if (!element?.matches("[data-formula-copyable], [data-inline-code-copyable]")) return;
    const root = rootRef.current;
    const target = root && resolveCopyTarget(element, root);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    void copyMarkdownTarget(target);
  }, [copyMarkdownTarget]);

  return { rootRef, onClickCapture, onKeyDownCapture, onPointerDownCapture };
}
