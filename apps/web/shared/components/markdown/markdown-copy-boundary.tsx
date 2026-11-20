"use client";

import * as React from "react";
import { Block, type BlockProps, parseMarkdownIntoBlocks } from "streamdown";
import { sourceOffsetMap, type SourceOffset } from "./markdown-source";
import { type CopyDocument, type CopyScope, registerMarkdownCopyScope } from "./markdown-selection-copy";

type StreamSource = { text: string; start: number };
const StreamCopyContext = React.createContext<{ scope: CopyScope; blocks: StreamSource[] } | null>(null);

function SourceScope({ scope, children }: { scope: CopyScope; children: React.ReactNode }) {
  const register = React.useCallback((element: HTMLDivElement | null) => {
    if (element) return registerMarkdownCopyScope(element, scope);
  }, [scope]);
  return <div ref={register} style={{ display: "contents" }} data-md-copy-scope="">{children}</div>;
}

export function MarkdownCopyBoundary({ document, map, input, streaming, children }: {
  document: CopyDocument;
  map: SourceOffset;
  input: string;
  streaming: boolean;
  children: React.ReactNode;
}) {
  const scope = React.useMemo<CopyScope>(() => ({ document, map }), [document, map]);
  const stream = React.useMemo(() => {
    if (!streaming) return null;
    const normalized = input.replace(/\r\n?/g, "\n");
    const restore = sourceOffsetMap(input, normalized);
    const streamScope: CopyScope = { document, map: (offset, bias) => {
      const local = restore(offset, bias);
      return local == null ? undefined : map(local, bias);
    } };
    // Streamdown splits the input before parsing individual blocks. Their AST
    // offsets start at zero. Record where each block begins in the message.
    let cursor = 0;
    const blocks = parseMarkdownIntoBlocks(normalized).map((text) => {
      const index = normalized.indexOf(text, cursor);
      if (index >= 0) cursor = index + text.length;
      return { text, start: index };
    });
    return { scope: streamScope, blocks };
  }, [input, streaming, document, map]);
  if (stream) return <StreamCopyContext.Provider value={stream}>{children}</StreamCopyContext.Provider>;
  return <SourceScope scope={scope}>{children}</SourceScope>;
}

export function SourceTrackedStreamdownBlock(props: BlockProps) {
  const stream = React.useContext(StreamCopyContext);
  const block = stream?.blocks[props.index];
  const scope = React.useMemo<CopyScope | undefined>(() => {
    if (!stream || !block || block.start < 0) return;
    const restore = sourceOffsetMap(block.text, props.content);
    return { document: stream.scope.document, map: (offset, bias) => {
      const local = restore(offset, bias);
      return local == null ? undefined : stream.scope.map(block.start + local, bias);
    } };
  }, [stream, block, props.content]);
  return scope ? <SourceScope scope={scope}><Block {...props} /></SourceScope> : <Block {...props} />;
}
