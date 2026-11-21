"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { type CopyActionInput, type CopyActionMessages, useCopyAction } from "@/shared/components/copy-action";
import { ClipboardImageUnavailable } from "@/shared/lib/clipboard-image";
import { listenForRichSelectionCopy, renderedRichClipboard } from "./markdown-rich-copy";

export function useRenderedCopy(messages: CopyActionMessages, trackSelection = true) {
  const t = useTranslations("chat.markdown");
  const { copy, reset, copied, pending } = useCopyAction({ messages });
  const report = React.useCallback((error: unknown) => {
    toast.error(t(error instanceof ClipboardImageUnavailable ? "copyImageUnavailable" : "copyRenderFailed"));
  }, [t]);
  React.useEffect(() => {
    if (trackSelection) return listenForRichSelectionCopy(document, report);
  }, [report, trackSelection]);

  const copyRendered = React.useCallback((root: Element | null, overrides?: CopyActionInput) => {
    try {
      return copy(root ? renderedRichClipboard(root) : undefined, overrides);
    } catch (error) {
      reset();
      report(error);
      return Promise.resolve(false);
    }
  }, [copy, report, reset]);
  return { copy, copied, pending, copyRendered };
}
