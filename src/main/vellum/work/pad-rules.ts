/**
 * Work-plane author rules for pad patches. Author class is not in pad.ts.
 */
import { resolvePadInboundActors } from "@shared/board-actors";
import type { CanvasDoc } from "@shared/canvas";
import type { Pad, PadPatch } from "@shared/pad";
import type { BoardAuthor } from "@shared/work-model";

export const inboundActorNodeIds = (
  doc: CanvasDoc,
  padNodeId: string,
): ReadonlySet<string> =>
  new Set(resolvePadInboundActors(doc, padNodeId).map((actor) => actor.nodeId));

const mentionsOf = (patch: PadPatch): ReadonlyArray<string> => {
  if (patch.op === "pin.upsert") return patch.pin.mentions;
  if (patch.op === "pin.reply") return [];
  return [];
};

/** Mentions newly added by this batch — moves that restamp the shell do not notify. */
export const addedPadMentions = (
  before: Pad,
  patches: ReadonlyArray<PadPatch>,
): ReadonlyArray<string> => {
  const added: string[] = [];
  const seen = new Set<string>();
  for (const patch of patches) {
    if (patch.op !== "pin.upsert") continue;
    const previous = new Set(
      before.pins.find((pin) => pin.id === patch.pin.id)?.mentions ?? [],
    );
    for (const mention of patch.pin.mentions) {
      if (previous.has(mention) || seen.has(mention)) continue;
      seen.add(mention);
      added.push(mention);
    }
  }
  return added;
};

/** Persist the WorkService author, never the client-supplied pin.reply body. */
export const stampPadPatchAuthors = (
  patches: ReadonlyArray<PadPatch>,
  author: BoardAuthor,
): ReadonlyArray<PadPatch> =>
  patches.map((patch) =>
    patch.op === "pin.reply"
      ? { ...patch, post: { ...patch.post, author } }
      : patch,
  );

export const padAuthorRuleError = (
  author: BoardAuthor,
  patches: ReadonlyArray<PadPatch>,
  inboundActors: ReadonlySet<string>,
): string | undefined => {
  for (const patch of patches) {
    if (author.kind === "actor") {
      if (patch.op === "upsert" && patch.layer === "ink") {
        return "agents cannot upsert ink";
      }
      if (patch.op === "upsert" && patch.layer === "image") {
        return "agents cannot upsert images";
      }
    }
    for (const mention of mentionsOf(patch)) {
      if (!inboundActors.has(mention)) {
        return `mention "${mention}" is not an inbound actor on this pad`;
      }
    }
  }
  return undefined;
};
