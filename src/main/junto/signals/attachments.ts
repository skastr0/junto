import { open } from "node:fs/promises";
import { Effect, Option } from "effect";
import type { AgentSignal, AgentSignalAttachment } from "@shared/agent-signals";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, attachmentName } from "@shared/preview-bytes";
import type { SignalAttachmentInput } from "@shared/work-control";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";
import { claimStagedContent } from "../content/stage";

/**
 * Files attached to a signal: main is the authority on what is admitted.
 *
 * The seat uploaded each file ahead of the signal (`content.stage`) and the
 * signal names it by reference. Admitted: any number of files, of any kind
 * and any size, each one uploaded by the calling seat. What a file is
 * recorded as (`attachmentMediaType`) is read here from the stored bytes and
 * the name main recorded at upload, never taken from the caller. A file is
 * held under the signal as owner, so it outlives the folder
 * it came from; it is let go when the signal closes and collected by the
 * store's own garbage collection after its grace.
 */

export type AttachmentRefusal = {
  /** `attach[2]`: which file. */
  readonly path: string;
  readonly message: string;
};

export { attachmentName };

/** The content store owner a signal's attachments are held under. */
export const signalAttachmentOwner = (
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId">,
): ContentOwner => ({
  kind: "other",
  canvasName: signal.canvasName,
  nodeId: signal.nodeId,
  recordId: `signal:${signal.signalId}`,
});

const readHead = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(limit);
    let filled = 0;
    // A read may come back short before the end of the file.
    while (filled < limit) {
      const { bytesRead } = await handle.read(head, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return head.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

const refusal = (index: number, message: string): AttachmentRefusal => ({ path: `attach[${index}]`, message });

/**
 * Take the files a signal names from the seat's uploads and hold them under
 * the signal, in order. Fails with the file refused and why; whatever was
 * already taken for this signal is let go again, so a refused signal keeps
 * nothing.
 */
export const claimSignalAttachments = (
  content: ContentService["Service"],
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId">,
  inputs: ReadonlyArray<SignalAttachmentInput>,
): Effect.Effect<ReadonlyArray<AgentSignalAttachment>, AttachmentRefusal> => {
  const owner = signalAttachmentOwner(signal);
  // The same file named twice is held once: a signal owns its bytes, not a count of them.
  const held = new Map<string, AgentSignalAttachment["ref"]>();
  return Effect.forEach(inputs, (input, index) =>
    Effect.gen(function* () {
      const key = `${input.ref.sha256}:${input.ref.byteLength}`;
      let ref = held.get(key);
      if (ref === undefined) {
        const row = yield* claimStagedContent(content, {
          canvasName: signal.canvasName,
          nodeId: signal.nodeId,
          ref: input.ref,
          owner,
        }).pipe(
          Effect.mapError((error) =>
            refusal(
              index,
              error instanceof Error && error.name === "NotStagedByCaller"
                ? error.message
                : "the file could not be taken from the store",
            ),
          ),
        );
        const name = attachmentName(row.ref.displayName ?? "") || "file";
        const opened = yield* content.openForRead(row.ref).pipe(Effect.orElseSucceed(() => undefined));
        if (opened?.state !== "verified") return yield* Effect.fail(refusal(index, `${name}: the file is not in the store`));
        const head = yield* Effect.tryPromise({
          try: () => readHead(opened.path, Math.min(row.ref.byteLength, ATTACHMENT_HEAD_BYTES)),
          catch: () => refusal(index, `${name}: the file could not be read from the store`),
        });
        ref = { ...row.ref, mediaType: attachmentMediaType(name, head), displayName: name } as AgentSignalAttachment["ref"];
        held.set(key, ref);
      }
      const caption = input.caption?.replace(/\s+/gu, " ").trim() || undefined;
      return {
        ref,
        ...(caption === undefined ? {} : { caption: caption as AgentSignalAttachment["caption"] }),
      } satisfies AgentSignalAttachment;
    }),
  ).pipe(Effect.tapError(() => content.releaseOwner(owner).pipe(Effect.ignore)));
};

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
