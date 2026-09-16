import { memo } from "react";
import Markdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./artifact-markdown.css";

const SAFE_URL_PATTERN = /^(?:https?:|mailto:|junto-content:|\/|#)/iu;

/**
 * Keep artifact links useful without giving Markdown a path to execute code.
 * `react-markdown` already rejects unsafe schemes by default; this explicit
 * transform also admits the app's content protocol for embedded media.
 */
export const safeArtifactMarkdownUrl = (
  value: string | undefined,
): string | undefined => {
  const url = value?.trim();
  if (!url || /[\u0000-\u001f\u007f]/u.test(url) || !SAFE_URL_PATTERN.test(url)) {
    return undefined;
  }
  return url;
};

export const artifactMarkdownUrlTransform: UrlTransform = (url) =>
  safeArtifactMarkdownUrl(url) ?? "";

const components: Components = {
  a: ({ node: _node, href, children, ...props }) => {
    const safeHref = safeArtifactMarkdownUrl(href);
    if (!safeHref) {
      return <span className="artifact-markdown__blocked-link">{children}</span>;
    }
    return (
      <a
        {...props}
        href={safeHref}
        target="_blank"
        rel="noreferrer noopener"
      >
        {children}
      </a>
    );
  },
  img: ({ node: _node, src, alt, ...props }) => {
    const safeSrc = safeArtifactMarkdownUrl(src);
    if (!safeSrc) {
      return (
        <span className="artifact-markdown__blocked-image">[image blocked]</span>
      );
    }
    return (
      <img
        {...props}
        src={safeSrc}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
      />
    );
  },
  input: ({ node: _node, ...props }) => (
    <input {...props} disabled tabIndex={-1} />
  ),
};

export type ArtifactMarkdownProps = {
  readonly source: string;
  readonly className?: string;
};

/**
 * Render artifact text as CommonMark plus the GFM extensions commonly emitted
 * by agents (tables, task lists, strikethrough, and autolinks).
 *
 * Raw HTML is deliberately skipped. Artifacts are agent-provided content and
 * must remain inert when they are opened in the renderer.
 */
export const ArtifactMarkdown = memo(function ArtifactMarkdown({
  source,
  className,
}: ArtifactMarkdownProps) {
  const shellClass = ["artifact-markdown", className].filter(Boolean).join(" ");
  return (
    <div className={shellClass} data-testid="artifact-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={artifactMarkdownUrlTransform}
        components={components}
      >
        {source}
      </Markdown>
    </div>
  );
});
