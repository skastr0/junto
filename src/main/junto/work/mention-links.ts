import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import { typedMentionsOf } from "@shared/typed-mentions";
import type { WorkErrorBody } from "@shared/work-control";
import { candidateOf, readItemsOn, type ResourceKind } from "../signals/resource-refs";
import {
  linkMentions,
  mailMentionCandidates,
  mentionNodesAt,
  pageMentionCandidates,
  resourceMentionCandidates,
  type MentionPlace,
} from "./authz";

/**
 * A text with every mention a writer typed rewritten to its link (03,
 * "Writing from the CLI"), on the one path every composer's send takes: mail
 * (`msg send`, `msg reply`) and the comments on a task, an artifact or a
 * page. Seats are the place's (wired in mail, in reach of the resource in
 * comments); tasks, artifacts and pages are `mentionNodesAt`. Items are read
 * only when the text has a `#` token, and archived artifacts are not offered.
 */
export const linkMentionsAt = (
  doc: Canvas,
  canvasName: string,
  writerId: string,
  text: string,
  place: MentionPlace,
): Effect.Effect<string, WorkErrorBody> =>
  Effect.gen(function* () {
    const nodes = mentionNodesAt(doc, writerId, place);
    const seats = place.kind === "mail" ? mailMentionCandidates(doc, writerId) : resourceMentionCandidates(doc, place.nodeId);
    const kinds = new Set<ResourceKind>(
      typedMentionsOf(text).flatMap((token): ReadonlyArray<ResourceKind> =>
        token.kind === "number" ? ["task"] : token.kind === "hash" ? ["task", "artifact"] : []),
    );
    const read = kinds.size === 0 ? { items: [], missing: new Set<ResourceKind>() } : yield* readItemsOn(canvasName, nodes, kinds);
    if (read.missing.size > 0) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: `${[...read.missing].join(" and ")}s cannot be mentioned in this Junto runtime`,
        details: { path: "text", reason: "not_available", retryable: false },
      });
    }
    const items = read.items.filter((item) => item.archived !== true).map(candidateOf);
    return yield* Effect.fromResult(
      linkMentions(doc, canvasName, writerId, text, { seats, pages: pageMentionCandidates(nodes), items }),
    );
  });
