import { Effect, Option } from "effect";
import {
  AGENT_SIGNAL_MAX_CAPTION_LENGTH,
  type AgentSignal,
  type AgentSignalAttachment,
} from "@shared/agent-signals";
import { classifyAttachment } from "@shared/preview-bytes";
import type { SignalAttachmentInput } from "@shared/work-control";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";

/**
 * Files attached to a signal: main is the authority on what is admitted.
 *
 * Admitted: any number of files of any size the request could carry, each
 * one something a preview can show (`classifyAttachment`: an image by its
 * bytes, or text by its name).
 * The bytes go into the content store under the signal as owner, so they
 * outlive the folder they came from; they are let go when the signal closes
 * and collected by the store's own garbage collection after its grace.
 */

export type AdmittedAttachment = {
  readonly name: string;
  readonly caption?: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
};

export type AttachmentRefusal = {
  /** `attach` for the list as a whole, `attach[2]` for one file. */
  readonly path: string;
  readonly message: string;
};

/** A display name: the last segment only, nothing a terminal or a table would choke on. */
export const attachmentName = (raw: string): string => {
  const last = raw.replace(/\\/gu, "/").split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 255);
};

const decodeBase64 = (encoded: string): Buffer | undefined => {
  const normalized = encoded.replace(/\s+/gu, "");
  if (normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)) return undefined;
  return Buffer.from(normalized, "base64");
};

/** Pure: decode and judge every file, or say which one is refused and why. */
export const admitSignalAttachments = (
  inputs: ReadonlyArray<SignalAttachmentInput>,
):
  | { readonly ok: true; readonly attachments: ReadonlyArray<AdmittedAttachment> }
  | { readonly ok: false; readonly refusal: AttachmentRefusal } => {
  const refuse = (path: string, message: string) => ({ ok: false as const, refusal: { path, message } });
  const attachments: AdmittedAttachment[] = [];
  for (const [index, input] of inputs.entries()) {
    const path = `attach[${index}]`;
    const name = attachmentName(input.name);
    if (!name) return refuse(path, "an attachment needs a file name");
    const bytes = decodeBase64(input.bytesBase64);
    if (!bytes) return refuse(path, `${name}: the bytes are not valid Base64`);
    const kind = classifyAttachment(name, bytes);
    if (!kind.ok) return refuse(path, `${name}: ${kind.reason}`);
    const caption = input.caption?.replace(/\s+/gu, " ").trim();
    if (caption !== undefined && caption.length > AGENT_SIGNAL_MAX_CAPTION_LENGTH) {
      return refuse(path, `${name}: a caption is at most ${AGENT_SIGNAL_MAX_CAPTION_LENGTH} characters`);
    }
    attachments.push({ name, mediaType: kind.mediaType, bytes, ...(caption ? { caption } : {}) });
  }
  return { ok: true, attachments };
};

/** The content store owner a signal's attachments are held under. */
export const signalAttachmentOwner = (
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId">,
): ContentOwner => ({
  kind: "other",
  canvasName: signal.canvasName,
  nodeId: signal.nodeId,
  recordId: `signal:${signal.signalId}`,
});

/** Put admitted files into the content store under the signal, in order. */
export const storeSignalAttachments = (
  content: ContentService["Service"],
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId">,
  admitted: ReadonlyArray<AdmittedAttachment>,
) =>
  Effect.forEach(admitted, (file) =>
    content
      .put({
        source: file.bytes,
        mediaType: file.mediaType,
        displayName: file.name,
        owner: signalAttachmentOwner(signal),
      })
      .pipe(
        Effect.map(
          (stored): AgentSignalAttachment => ({
            ref: stored.ref,
            ...(file.caption === undefined ? {} : { caption: file.caption as AgentSignalAttachment["caption"] }),
          }),
        ),
      ),
  );

/**
 * A closed signal lets go of its files. Never fails the close: a reference
 * left behind only keeps bytes longer than needed.
 */
export const releaseSignalAttachments = (signal: AgentSignal): Effect.Effect<void> =>
  signal.attachments === undefined || signal.state === "open"
    ? Effect.void
    : Effect.serviceOption(ContentService).pipe(
        Effect.flatMap((content) =>
          Option.isNone(content)
            ? Effect.void
            : content.value.releaseOwner(signalAttachmentOwner(signal)).pipe(Effect.ignore),
        ),
      );
