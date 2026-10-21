import { open } from "node:fs/promises";
import { Effect, Option } from "effect";
import {
  admitLinkUrl,
  type AgentSignal,
  type AgentSignalAttachment,
  type AgentSignalAttachmentInput,
} from "@shared/agent-signals";
import { MENTION_KIND_OF_NODE, parseMentionHref } from "@shared/mention";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, attachmentName, isTextHead } from "@shared/preview-bytes";
import { asNodeId, type NodeId } from "@shared/physics/schema";
import { resourcesInReach, type ReachCanvas } from "@shared/region-reach";
import type { ItemId } from "@shared/work-ids";
import type { ContentOwner } from "../content/manifest";
import { ContentService } from "../content/service";
import { claimStagedContent } from "../content/stage";

/**
 * Files attached to a signal: main is the authority on what is admitted.
 *
 * The seat uploaded each file ahead of the signal (`content.stage`) and the
 * signal names it by reference. Admitted: any number of files, of any kind
 * and any size, each one uploaded by the calling seat; the two texts of a
 * compare the same way; a commit by its full id; a link by a web address; a
 * task or an artifact by its ref, when it is in the seat's reach and on its
 * node now (`SignalResources`). What a file is
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
 * What a task or an artifact attachment is judged against: the canvas the
 * seat is on, and whether an item is on its node now. Without it the runtime
 * takes neither.
 */
export type SignalResources = {
  readonly canvas: ReachCanvas;
  readonly holds: (kind: "task" | "artifact", nodeId: NodeId, item: ItemId) => boolean;
};

type ResourceInput = Extract<AgentSignalAttachmentInput, { readonly kind: "task" | "artifact" }>;

/**
 * A task or an artifact the seat names, admitted: its ref is a canonical node
 * ref with an item, the node is that kind's, it is in the seat's reach, and
 * the item is on it now. Otherwise the reason, in the seat's words.
 */
export const admitResourceAttachment = (
  input: ResourceInput,
  seatId: NodeId,
  resources: SignalResources,
): { readonly ok: true; readonly attachment: AgentSignalAttachment } | { readonly ok: false; readonly reason: string } => {
  const noun = input.kind;
  const target = parseMentionHref(input.ref.trim());
  if (target?.item === undefined) {
    return { ok: false, reason: `a ${noun} is named by its ref: junto://canvas/<canvas>?node=<id>&item=<id>` };
  }
  const node = resources.canvas.nodes.get(target.nodeId);
  const kind = node === undefined || !Object.hasOwn(MENTION_KIND_OF_NODE, node.kind)
    ? undefined
    : MENTION_KIND_OF_NODE[node.kind as keyof typeof MENTION_KIND_OF_NODE];
  if (kind !== noun) return { ok: false, reason: `${target.nodeId} holds no ${noun}s on this canvas` };
  if (!resourcesInReach(resources.canvas, seatId).some((reached) => reached.id === target.nodeId)) {
    return { ok: false, reason: `${target.nodeId} is out of this seat's reach` };
  }
  if (!resources.holds(noun, target.nodeId, target.item)) {
    return { ok: false, reason: `no ${noun} ${target.item} on ${target.nodeId}` };
  }
  const said = input.caption?.replace(/\s+/gu, " ").trim() || undefined;
  const caption = said === undefined ? {} : { caption: said };
  return {
    ok: true,
    attachment: noun === "task"
      ? { kind: "task", nodeId: target.nodeId, taskId: target.item, ...caption }
      : { kind: "artifact", nodeId: target.nodeId, artifactId: target.item, ...caption },
  };
};

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
  resources?: SignalResources,
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
      if (input.kind === "task" || input.kind === "artifact") {
        if (resources === undefined) {
          return yield* Effect.fail(refusal(index, `${input.kind}s cannot be attached in this Junto runtime`));
        }
        const admitted = admitResourceAttachment(input, asNodeId(signal.nodeId), resources);
        if (!admitted.ok) return yield* Effect.fail(refusal(index, admitted.reason));
        return admitted.attachment;
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
