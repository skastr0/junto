import { ExternalLink, FileText, FolderOpen } from "lucide-react";
import type { FileBody, FileSource, LinkBody } from "@shared/artifact";
import { ContentMedia } from "../work/ContentMedia";
import { Eyebrow } from "../ui";

/** A link artifact: where it points, opened in the browser. Content links preview like files. */
export function LinkPreview({ body }: { readonly body: LinkBody }) {
  if (body.target.kind === "content") return <FilePreview body={{ type: "file", content: body.target.content }} />;
  const { url } = body.target;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // A link body's url is decoded http(s); the raw string is the fallback label.
  }
  return (
    <div className="artifact-preview artifact-preview--link">
      <Eyebrow tone="steel" size="xs">
        {host}
      </Eyebrow>
      <a className="artifact-preview__url" href={url} target="_blank" rel="noreferrer noopener">
        <span>{url}</span>
        <ExternalLink size={13} aria-hidden />
      </a>
    </div>
  );
}

/** Where an extracted file came from, in words: its path, and its page for a PDF. */
export const fileSourceLine = (source: FileSource): string =>
  source.page === undefined ? `From ${source.path}` : `From ${source.path}, page ${String(source.page)}`;

/**
 * A file artifact: images, video and text shown in place, anything else named
 * with its size. One extracted from a Files node names its source, and a host
 * that can reach that node opens it there.
 */
export function FilePreview({
  body,
  onOpenSource,
}: {
  readonly body: FileBody;
  readonly onOpenSource?: ((source: FileSource) => void) | undefined;
}) {
  const { content, source } = body;
  return (
    <div className="artifact-preview artifact-preview--file">
      <div className="artifact-preview__meta">
        <FileText size={13} aria-hidden />
        <span>{content.displayName ?? content.sha256.slice(0, 12)}</span>
        <span className="artifact-preview__size">
          {content.mediaType}, {formatBytes(content.byteLength)}
        </span>
      </div>
      {source === undefined ? null : onOpenSource === undefined ? (
        <p className="artifact-preview__source">{fileSourceLine(source)}</p>
      ) : (
        <button
          type="button"
          className="artifact-preview__source"
          // The name keeps the words shown and says what the press does.
          aria-label={`${fileSourceLine(source)}, open in its Files node`}
          title={`Open ${source.path} in its Files node`}
          onClick={() => onOpenSource(source)}
        >
          <FolderOpen size={13} aria-hidden />
          <span>{fileSourceLine(source)}</span>
        </button>
      )}
      <div className="artifact-preview__media">
        <ContentMedia contentRef={content} alt={content.displayName ?? "File"} renderMarkdown={isMarkdownFile(content)} />
      </div>
    </div>
  );
}

/**
 * Only Markdown reads as Markdown: plain text keeps its line breaks, which
 * Markdown would run together.
 */
export const isMarkdownFile = (content: { readonly mediaType: string; readonly displayName?: string }): boolean =>
  /^text\/(?:markdown|x-markdown)\b/iu.test(content.mediaType) || /\.(?:md|markdown)$/iu.test(content.displayName ?? "");

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
