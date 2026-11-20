"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { isOneOf } from "@/shared/lib/type-guards";
import {
  sanitizeHTMLStyle,
  sanitizeKatexHTMLStyle,
} from "./streamdown-style";

type MarkdownHTMLBlockProps = React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode;
  node?: unknown;
};

type MarkdownHTMLInlineProps = React.HTMLAttributes<HTMLSpanElement> & {
  children?: React.ReactNode;
  node?: unknown;
};

type MarkdownHTMLDetailsProps = React.DetailsHTMLAttributes<HTMLDetailsElement> & {
  children?: React.ReactNode;
  node?: unknown;
};

export const MarkdownFootnotesContext = React.createContext(false);

const KATEX_SPAN_CLASS_NAMES = [
  "katex",
  "katex-display",
  "katex-html",
  "katex-mathml",
  "katex-base",
  "katex-strut",
  "mord",
  "mop",
  "mbin",
  "mrel",
  "mopen",
  "mclose",
  "mpunct",
  "minner",
  "msupsub",
  "vlist",
  "vlist-t",
  "vlist-r",
  "vlist-s",
  "pstrut",
  "katex-sizing",
  "mtight",
  "mspace",
  "mfrac",
  "frac-line",
  "mathrm",
  "mathnormal",
  "mathit",
  "mathbf",
  "textbf",
  "textrm",
  "mainrm",
] as const;

const isKatexSpanClassName = isOneOf(KATEX_SPAN_CLASS_NAMES);

function isKatexSpan(className: string | undefined, style: React.CSSProperties | undefined): boolean {
  if (typeof style?.top !== "undefined") {
    return true;
  }
  const classNames = className?.trim().split(/\s+/) ?? [];
  return classNames.some((item) => (
    isKatexSpanClassName(item) ||
    /^reset-size\d+$/.test(item) ||
    /^size\d+$/.test(item)
  ));
}

export function MarkdownHTMLDiv({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  return (
    <div {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </div>
  );
}

export function MarkdownHTMLSection({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  const footnotes = "data-footnotes" in props || className?.split(/\s+/).includes("footnotes") === true;
  const section = (
    <section {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </section>
  );

  return footnotes ? <MarkdownFootnotesContext.Provider value>{section}</MarkdownFootnotesContext.Provider> : section;
}

export function MarkdownHTMLArticle({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  return (
    <article {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </article>
  );
}

export function MarkdownHTMLAside({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  return (
    <aside {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </aside>
  );
}

export function MarkdownHTMLMain({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  return (
    <main {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </main>
  );
}

export function MarkdownHTMLDetails({ children, className, node: _node, open, style, ...props }: MarkdownHTMLDetailsProps) {
  return (
    <details {...props} className={cn("min-w-0 max-w-full", className)} open={open} style={sanitizeHTMLStyle(style)}>
      {children}
    </details>
  );
}

export function MarkdownHTMLSummary({ children, className, node: _node, style, ...props }: MarkdownHTMLBlockProps) {
  return (
    <summary {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </summary>
  );
}

export function MarkdownHTMLSpan({ children, className, node: _node, style, ...props }: MarkdownHTMLInlineProps) {
  if (isKatexSpan(className, style)) {
    return (
      <span {...props} className={className} style={sanitizeKatexHTMLStyle(style)}>
        {children}
      </span>
    );
  }

  return (
    <span {...props} className={cn("min-w-0 max-w-full", className)} style={sanitizeHTMLStyle(style)}>
      {children}
    </span>
  );
}