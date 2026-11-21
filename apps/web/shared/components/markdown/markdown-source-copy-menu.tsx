"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useCopyAction } from "@/shared/components/copy-action";
import { messageSelectionSource } from "./markdown-selection-copy";

export function MarkdownSourceCopyMenu({ source, bodyRef, disabled, className, labeled }: {
  source: string;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  className?: string;
  labeled?: boolean;
}) {
  const t = useTranslations("chat.messages");
  const mathT = useTranslations("chat.markdown");
  const { copy, pending } = useCopyAction({ messages: { copied: t("copied"), failed: t("copyFailed") } });
  const [selected, setSelected] = React.useState<ReturnType<typeof messageSelectionSource>>();

  return (
    <DropdownMenu modal={false} onOpenChange={(open) => {
      // The selection is still in the message when the trigger opens the menu.
      if (open) setSelected(bodyRef.current ? messageSelectionSource(bodyRef.current) : undefined);
    }}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={labeled ? "sm" : "icon-sm"}
          className={cn("text-muted-foreground", labeled && "h-6 gap-1 px-2 text-xs", className)}
          title={t("copySourceOptions")}
          aria-label={t("copySourceOptions")}
          disabled={disabled || pending || !source.trim()}
          data-screenshot-exclude="true"
        >
          {labeled ? t("copySource") : null}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={labeled ? "end" : "start"}>
        <DropdownMenuItem onSelect={() => void copy(source)}>{t("copyMarkdownSource")}</DropdownMenuItem>
        {selected?.markdown ? (
          <DropdownMenuItem onSelect={() => void copy(selected.markdown)}>{t("copySelectionSource")}</DropdownMenuItem>
        ) : null}
        {selected?.latex ? (
          <DropdownMenuItem onSelect={() => void copy(selected.latex, { copied: mathT("latexCopied"), failed: mathT("latexCopyFailed") })}>
            {mathT("copyLatex")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
