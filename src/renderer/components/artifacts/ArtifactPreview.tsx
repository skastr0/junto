import { ExternalLink, FileText } from "lucide-react";
import type { FileBody, LinkBody } from "@shared/artifact";
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

/** A file artifact: images, video and text shown in place, anything else named with its size. */
export function FilePreview({ body }: { readonly body: FileBody }) {
  const { content } = body;
  return (
    <div className="artifact-preview artifact-preview--file">
      <div className="artifact-preview__meta">
        <FileText size={13} aria-hidden />
        <span>{content.displayName ?? content.sha256.slice(0, 12)}</span>
        <span className="artifact-preview__size">
          {content.mediaType}, {formatBytes(content.byteLength)}
        </span>
      </div>
      <div className="artifact-preview__media">
        <ContentMedia contentRef={content} alt={content.displayName ?? "File"} renderMarkdown />
      </div>
    </div>
  );
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
