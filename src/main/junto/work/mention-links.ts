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
  type LinkedText,
  type MentionPlace,
} from "./authz";

/**
 * A text with every mention a writer typed rewritten to its link (03,
 * "Writing from the CLI"), on the one path every composer's send takes: mail
 * (`msg send`, `msg reply`) and the comments on a task, an artifact or a
 * page. Seats are the place's (wired in mail, in reach of the resource in
 * comments); tasks, artifacts and pages are `mentionNodesAt`. Items are read
 * only when the text has a `#` token, and archived artifacts are not offered.
 * A token that names nothing here, items this runtime cannot read among
 * them, stays plain text and is listed in `unlinked`.
 */
export const linkMentionsAt = (
  doc: Canvas,
  canvasName: string,
  writerId: string,
  text: string,
  place: MentionPlace,
): Effect.Effect<LinkedText, WorkErrorBody> =>
  Effect.gen(function* () {
    const nodes = mentionNodesAt(doc, writerId, place);
    const seats = place.kind === "mail" ? mailMentionCandidates(doc, writerId) : resourceMentionCandidates(doc, place.nodeId);
    const kinds = new Set<ResourceKind>(
      typedMentionsOf(text).flatMap((token): ReadonlyArray<ResourceKind> =>
        token.kind === "number" ? ["task"] : token.kind === "hash" ? ["task", "artifact"] : []),
    );
    const read = kinds.size === 0 ? { items: [] } : yield* readItemsOn(canvasName, nodes, kinds);
    const items = read.items.filter((item) => item.archived !== true).map(candidateOf);
    return yield* Effect.fromResult(
      linkMentions(doc, canvasName, writerId, text, { seats, pages: pageMentionCandidates(nodes), items }),
    );
  });

/** The receipt's `unlinked` list, present only when a token linked to nothing. */
export const unlinkedField = (linked: LinkedText): { readonly unlinked?: LinkedText["unlinked"] } =>
  linked.unlinked.length === 0 ? {} : { unlinked: linked.unlinked };
