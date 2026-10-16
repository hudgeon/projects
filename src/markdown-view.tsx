import React from "react";
import { renderInlineMarkdown, renderMarkdown } from "./markdown";
// HTML is produced only by the shared, HTML-disabled Markdown renderer.
export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
export function InlineMarkdown({ text }: { text: string }) {
  return <span dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(text) }} />;
}
