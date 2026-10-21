import type { AgentSignal } from "@shared/agent-signals";
import type { ContentRef } from "@shared/content";
import { contentObjectUrl } from "@shared/content-url";
import { previewExtension, previewLinkName, type PreviewResult } from "@shared/preview";
import type { ContentOpenForRead } from "../content/service";
import { readAttachmentPreview, readComparePreview, type PreviewThumbnailer } from "../preview/read";
import { signalFileRefs } from "./taken-attachments";

export type SignalAttachmentPreviewDeps = {
  /** The content store's file for a reference, when this machine holds it. */
  readonly open: (ref: ContentRef) => Promise<ContentOpenForRead | undefined>;
  /** Bring these files from the seat's machine; the signal as it reads after, or undefined. */
  readonly pull: (signal: AgentSignal, refs: ReadonlyArray<ContentRef>) => Promise<AgentSignal | undefined>;
};

/**
 * One preview of a signal's attachment, by its place in the signal's own
 * list: then the content store's file for that reference. No path from
 * anyone. A seat's file on another machine is pulled here only when the
 * operator opens it (the full variant). A card's thumb never pulls: it
 * shows the file by name and size until then.
 */
export const readSignalAttachmentPreview = async (
  deps: SignalAttachmentPreviewDeps,
  input: {
    readonly signal: AgentSignal | undefined;
    readonly index: number;
    readonly render: { readonly variant: "thumb" | "full"; readonly thumbnail?: PreviewThumbnailer; readonly thumbEdge: number };
  },
): Promise<PreviewResult> => {
  let signal = input.signal;
  let attachment = Number.isInteger(input.index) ? signal?.attachments?.[input.index] : undefined;
  if (!attachment || !signal) return { ok: false, reason: "not-named" };
  const away: Array<ContentRef> = [];
  for (const ref of signalFileRefs([attachment])) if ((await deps.open(ref))?.state !== "verified") away.push(ref);
  if (away.length > 0) {
    if (input.render.variant === "thumb") {
      const name = "kind" in attachment ? (attachment.kind === "compare" ? attachment.name ?? attachment.after.displayName ?? "changes" : undefined) : attachment.ref.displayName ?? "file";
      if (name !== undefined) {
        const byteLength = signalFileRefs([attachment]).reduce((total, ref) => total + ref.byteLength, 0);
        return { ok: true, kind: "file", name, byteLength, extension: previewExtension(`/${name}`) };
      }
    } else {
      signal = (await deps.pull(signal, away).catch(() => undefined)) ?? signal;
      attachment = signal.attachments?.[input.index] ?? attachment;
    }
  }
  if ("kind" in attachment) {
    if (attachment.kind === "commit") {
      return { ok: true, kind: "commit", name: attachment.sha.slice(0, 7), sha: attachment.sha };
    }
    if (attachment.kind === "link") {
      return { ok: true, kind: "link", name: previewLinkName(attachment.url), url: attachment.url };
    }
    // A task or an artifact is a chip that opens it on the canvas, never a preview.
    if (attachment.kind === "task" || attachment.kind === "artifact") return { ok: false, reason: "not-named" };
    const [before, after] = await Promise.all([deps.open(attachment.before), deps.open(attachment.after)]);
    if (before?.state !== "verified" || after?.state !== "verified") return { ok: false, reason: "missing" };
    return readComparePreview({
      beforePath: before.path,
      afterPath: after.path,
      name: attachment.name ?? attachment.after.displayName ?? "changes",
    });
  }
  const opened = await deps.open(attachment.ref);
  if (opened?.state !== "verified") return { ok: false, reason: "missing" };
  return readAttachmentPreview({
    objectPath: opened.path,
    byteLength: opened.byteLength,
    name: attachment.ref.displayName ?? "file",
    streamUrl: contentObjectUrl(attachment.ref),
    ...input.render,
  });
};
