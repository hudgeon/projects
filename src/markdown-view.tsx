import React, { useMemo } from "react";
import { renderInlineMarkdown, renderMarkdown } from "./markdown";
import { htmlSource } from "./document-model";
import { useOpenDocument } from "./document-view";
// A plain click on a committed HTML page opens it here; other links, and
// modified clicks, go where they point.
function useDocumentClicks() {
  const open = useOpenDocument();
  return (event: React.MouseEvent) => {
    const link = (event.target as Element).closest?.("a[href]");
    const href = link?.getAttribute("href") ?? "";
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !htmlSource(href)) return;
    event.preventDefault();
    open(href);
  };
}
// HTML is produced only by the shared, HTML-disabled Markdown renderer.
export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  // Keep the HTML prop stable so unrelated refreshes do not replace selected text.
  const html = useMemo(() => ({ __html: renderMarkdown(text) }), [text]);
  return <div className={className} onClick={useDocumentClicks()} dangerouslySetInnerHTML={html} />;
}
export function InlineMarkdown({ text }: { text: string }) {
  const html = useMemo(() => ({ __html: renderInlineMarkdown(text) }), [text]);
  return <span onClick={useDocumentClicks()} dangerouslySetInnerHTML={html} />;
}
