import { memo, useMemo, type ReactNode } from "react";
import Markdown, { type Components, type ExtraProps, type UrlTransform } from "react-markdown";
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

const SafeLink: NonNullable<Components["a"]> = ({ node: _node, href, children, ...props }) => {
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
};

const components: Components = {
  a: SafeLink,
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

/** What a link is drawn as when the app draws it itself: a mention chip, say. */
export type MarkdownLinkRenderer = (href: string, label: string) => ReactNode | undefined;

/** The plain text under a parsed node: a link's label as the writer typed it, less its markup. */
const textOf = (node: ExtraProps["node"]): string =>
  (node?.children ?? [])
    .map((child) => (child.type === "text" ? child.value : child.type === "element" ? textOf(child) : ""))
    .join("");

/**
 * The components and url filter for one renderer. With `renderLink`, a
 * `junto://` link is kept past the filter and drawn by it; whatever it
 * declines is drawn blocked, like any other link the filter refuses.
 */
const withLinks = (renderLink: MarkdownLinkRenderer): { components: Components; urlTransform: UrlTransform } => ({
  urlTransform: (url) => (url.startsWith("junto://") ? url : (safeArtifactMarkdownUrl(url) ?? "")),
  components: {
    ...components,
    a: (props) => {
      if (!props.href?.startsWith("junto://")) return <SafeLink {...props} />;
      return renderLink(props.href, textOf(props.node)) ?? <span className="artifact-markdown__blocked-link">{props.children}</span>;
    },
  },
});

export type ArtifactMarkdownProps = {
  readonly source: string;
  readonly className?: string;
  /** Draws the app's own `junto://` links; without it they are blocked. */
  readonly renderLink?: MarkdownLinkRenderer;
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
  renderLink,
}: ArtifactMarkdownProps) {
  const shellClass = ["artifact-markdown", className].filter(Boolean).join(" ");
  const drawn = useMemo(
    () => (renderLink === undefined ? { components, urlTransform: artifactMarkdownUrlTransform } : withLinks(renderLink)),
    [renderLink],
  );
  return (
    <div className={shellClass} data-testid="artifact-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={drawn.urlTransform}
        components={drawn.components}
      >
        {source}
      </Markdown>
    </div>
  );
});
