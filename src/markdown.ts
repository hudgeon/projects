import MarkdownIt from "markdown-it";
// Raw HTML, images and non-HTTPS URLs cannot introduce content or tracking.
const markdown = new MarkdownIt({ html: false, linkify: false }).disable("image");
markdown.validateLink = (url: string) => {
  try { const u = new URL(url); return u.protocol === "https:" && !u.username && !u.password; }
  catch { return false; }
};
// Native output is untrusted: keep the same no-HTML/no-images/HTTPS-only boundary.
const renderLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderLink
    ? renderLink(tokens, index, options, env, renderer)
    : renderer.renderToken(tokens, index, options);
};
export function renderMarkdown(text: string) { return markdown.render(text); }
// One line of agent text (a progress step or label): same rules, no block wrapper.
export function renderInlineMarkdown(text: string) { return markdown.renderInline(text); }
