import { admitLinkUrl, type AgentSignalAttachment } from "@shared/agent-signals";
import { ATTACHMENT_OTHER_MEDIA_TYPE, attachmentName } from "@shared/preview-bytes";
import type { ContentRef } from "@shared/wire/content-ref";

/**
 * What a raise another machine stated keeps here of what the seat attached.
 * A file's reference is kept without the type it states: until its bytes are
 * pulled here and judged (`judgedSignalFile`), it is a file of no stated
 * kind. Its name is cleaned as an upload's is. A commit or a link is admitted
 * again by the same rule the seat's machine used, and one that fails it is
 * left out. A task or an artifact is a name on the canvas, opened by its ref.
 */
export const takenSignalAttachments = (stated: ReadonlyArray<AgentSignalAttachment>): ReadonlyArray<AgentSignalAttachment> =>
  stated.flatMap((attachment): ReadonlyArray<AgentSignalAttachment> => {
    if (!("kind" in attachment)) return [{ ...attachment, ref: unjudged(attachment.ref) }];
    if (attachment.kind === "compare") return [{ ...attachment, before: unjudged(attachment.before), after: unjudged(attachment.after) }];
    if (attachment.kind === "commit") return /^[a-f0-9]{40}$/u.test(attachment.sha) ? [attachment] : [];
    if (attachment.kind === "link") {
      const link = admitLinkUrl(attachment.url);
      return link.ok ? [{ ...attachment, url: link.url }] : [];
    }
    return [attachment];
  });

const unjudged = (ref: ContentRef): ContentRef =>
  ({
    sha256: ref.sha256,
    byteLength: ref.byteLength,
    mediaType: ATTACHMENT_OTHER_MEDIA_TYPE,
    displayName: attachmentName(ref.displayName ?? "") || "file",
  }) as ContentRef;

/** The files of a signal, each once: a file's ref, and both sides of a compare. */
export const signalFileRefs = (attachments: ReadonlyArray<AgentSignalAttachment> | undefined): ReadonlyArray<ContentRef> => {
  const refs = new Map<string, ContentRef>();
  for (const attachment of attachments ?? []) {
    const named = !("kind" in attachment) ? [attachment.ref] : attachment.kind === "compare" ? [attachment.before, attachment.after] : [];
    for (const ref of named) refs.set(`${ref.sha256}:${ref.byteLength}`, ref);
  }
  return [...refs.values()];
};
