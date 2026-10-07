import { open } from "node:fs/promises";
import { Effect, Option } from "effect";
import {
  admitLinkUrl,
  type AgentSignal,
  type AgentSignalAttachment,
  type AgentSignalAttachmentInput,
} from "@shared/agent-signals";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, attachmentName, isTextHead } from "@shared/preview-bytes";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";
import { claimStagedContent } from "../content/stage";

/**
 * Files attached to a signal: main is the authority on what is admitted.
 *
 * The seat uploaded each file ahead of the signal (`content.stage`) and the
 * signal names it by reference. Admitted: any number of files, of any kind
 * and any size, each one uploaded by the calling seat; the two texts of a
 * compare the same way; a commit by its full id; a link by a web address. What a file is
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

type Stored = Extract<AgentSignalAttachment, { readonly ref: unknown }>["ref"];

/**
 * Take what a signal names and hold it under the signal, in order: files and
 * the two sides of a compare from the seat's uploads, a commit by its id, a
 * link by its address. Fails with the one refused and why; whatever was
 * already taken for this signal is let go again, so a refused signal keeps
 * nothing.
 */
export const claimSignalAttachments = (
  content: ContentService["Service"],
  signal: Pick<AgentSignal, "signalId" | "canvasName" | "nodeId">,
  inputs: ReadonlyArray<AgentSignalAttachmentInput>,
): Effect.Effect<ReadonlyArray<AgentSignalAttachment>, AttachmentRefusal> => {
  const owner = signalAttachmentOwner(signal);
  // The same file named twice is held once: a signal owns its bytes, not a count of them.
  const held = new Map<string, { readonly ref: Stored; readonly text: boolean }>();
  const take = (index: number, identity: { readonly sha256: string; readonly byteLength: number }) =>
    Effect.gen(function* () {
      const key = `${identity.sha256}:${identity.byteLength}`;
      const known = held.get(key);
      if (known !== undefined) return known;
      const row = yield* claimStagedContent(content, {
        canvasName: signal.canvasName,
        nodeId: signal.nodeId,
        ref: identity,
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
      const taken = {
        ref: { ...row.ref, mediaType: attachmentMediaType(name, head), displayName: name } as Stored,
        text: isTextHead(head),
      };
      held.set(key, taken);
      return taken;
    });
  return Effect.forEach(inputs, (input, index) =>
    Effect.gen(function* () {
      const said = input.caption?.replace(/\s+/gu, " ").trim() || undefined;
      const caption = said === undefined ? {} : { caption: said };
      if (!("kind" in input)) {
        return { ref: (yield* take(index, input.ref)).ref, ...caption } as AgentSignalAttachment;
      }
      if (input.kind === "compare") {
        const before = yield* take(index, input.before);
        const after = yield* take(index, input.after);
        if (!before.text || !after.text) {
          return yield* Effect.fail(refusal(index, "a compare takes two texts; one of these is not text"));
        }
        const name = attachmentName(input.name ?? "") || undefined;
        return {
          kind: "compare",
          before: before.ref,
          after: after.ref,
          ...(name === undefined ? {} : { name }),
          ...caption,
        } as AgentSignalAttachment;
      }
      if (input.kind === "commit") {
        const sha = input.sha.trim().toLowerCase();
        if (!/^[a-f0-9]{40}$/u.test(sha)) {
          return yield* Effect.fail(refusal(index, "a commit is named by its full id: forty hex characters"));
        }
        return { kind: "commit", sha, ...caption } as AgentSignalAttachment;
      }
      const link = admitLinkUrl(input.url);
      if (!link.ok) return yield* Effect.fail(refusal(index, link.reason));
      return { kind: "link", url: link.url, ...caption } as AgentSignalAttachment;
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
