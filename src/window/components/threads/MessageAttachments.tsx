import { useState } from "react";
import { File as FileGlyph } from "lucide-react";
import { contentObjectUrl } from "@shared/content-url";
import { attachmentDisplayName, attachmentSizeLabel, isThumbnailType } from "@shared/operator-attachments";
import type { ContentRef } from "@shared/wire/content-ref";

/**
 * The files a thread mail carries: an image as its thumbnail, anything else
 * as a file chip with its name, type and size. Drawn from the content store
 * and never opened: no file is run, and none is handed to the system. A
 * thumbnail the renderer cannot decode (a HEIC, a damaged image) falls back
 * to the chip.
 */

const extensionOf = (name: string): string | undefined => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).slice(0, 5).toUpperCase() : undefined;
};

function Attachment({ file }: { readonly file: ContentRef }) {
  const [undrawn, setUndrawn] = useState(false);
  const name = attachmentDisplayName(file);
  if (isThumbnailType(file.mediaType) && !undrawn) {
    return (
      <li className="seat-threads__attachment seat-threads__attachment--image" data-testid="seat-threads-attachment" data-kind="image">
        <img
          src={contentObjectUrl(file)}
          alt={name}
          title={`${name}, ${attachmentSizeLabel(file.byteLength)}`}
          loading="lazy"
          draggable={false}
          onError={() => setUndrawn(true)}
        />
      </li>
    );
  }
  return (
    <li className="seat-threads__attachment seat-threads__attachment--file" data-testid="seat-threads-attachment" data-kind="file">
      <span className="seat-threads__attachment-glyph" aria-hidden>
        <FileGlyph size={14} />
        {extensionOf(name) ? <span>{extensionOf(name)}</span> : null}
      </span>
      <span className="seat-threads__attachment-text">
        <span className="seat-threads__attachment-name" title={name}>
          {name}
        </span>
        <span className="seat-threads__attachment-meta">
          {file.mediaType}, {attachmentSizeLabel(file.byteLength)}
        </span>
      </span>
    </li>
  );
}

export function MessageAttachments({ files }: { readonly files: ReadonlyArray<ContentRef> }) {
  if (files.length === 0) return null;
  return (
    <ul
      className="seat-threads__attachments"
      aria-label={`${files.length} ${files.length === 1 ? "file" : "files"} attached`}
      data-testid="seat-threads-attachments"
    >
      {files.map((file) => (
        <Attachment key={`${file.sha256}:${file.displayName ?? ""}`} file={file} />
      ))}
    </ul>
  );
}
