import { Effect, Option } from "effect";
import {
  briefingItemKind,
  briefingLinksOf,
  briefingMentionOf,
  type BriefingLinkFacts,
  type BriefingMention,
} from "@shared/briefing-mentions";
import { titleOf, type Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import type { TaskId } from "@shared/task-model";
import type { ItemId } from "@shared/work-ids";
import { reaches, seatReachesTaskNode } from "@shared/region-reach";
import { ModelService } from "../model/service";
import { areConnected } from "../work/authz";
import { ArtifactRepository } from "../work/artifact-repository";
import { TaskRepository } from "../work/task-repository";

/**
 * The mentions beside a briefing's text (docs/plans/0.11/08 B2, the rule in
 * shared/briefing-mentions.ts), resolved for the seat that reads it on its
 * own canvas: node kinds and titles from the canvas, a task's title from the
 * task store, an artifact's from the artifact store.
 *
 * Undefined when the text links nothing, and when what it links cannot be
 * read (no store in this runtime, or a read that failed): the text is
 * still returned, so a briefing never fails for its mentions, and a gone
 * thing is only ever called missing when it is.
 */
export type BriefingReader = { readonly canvasName: string; readonly nodeId: string };

const canAct = (canvas: Canvas, reader: NodeId, nodeId: NodeId): boolean => {
  const node = canvas.nodes.get(nodeId);
  if (node === undefined) return false;
  if (node.kind === "agent") return areConnected(canvas, reader, nodeId);
  if (node.kind === "task") return seatReachesTaskNode(canvas, reader, nodeId);
  return reaches(canvas, reader, nodeId);
};

/** The mentions in `text`, against a canvas already read. */
export const briefingMentionsOn = (
  canvas: Canvas,
  reader: BriefingReader,
  text: string,
): Effect.Effect<ReadonlyArray<BriefingMention> | undefined> =>
  Effect.gen(function* () {
    const links = briefingLinksOf(text);
    if (links.length === 0) return undefined;
    const artifacts = yield* Effect.serviceOption(ArtifactRepository);
    const tasks = yield* Effect.serviceOption(TaskRepository);
    const self = reader.nodeId as NodeId;
    const mentions: BriefingMention[] = [];
    // Each lookup: the item's title and the node it lives on, null when it is gone, undefined when it cannot be read here.
    type Found = { readonly title: string; readonly nodeId: NodeId } | null | undefined;
    const task = (id: ItemId): Effect.Effect<Found> =>
      Option.isNone(tasks)
        ? Effect.succeed(undefined)
        : tasks.value.get(reader.canvasName, id as string as TaskId).pipe(
            Effect.map((found): Found => (Option.isSome(found) ? { title: found.value.title, nodeId: found.value.current.node as NodeId } : null)),
            Effect.orElseSucceed((): Found => undefined),
          );
    const artifact = (id: ItemId): Effect.Effect<Found> =>
      Option.isNone(artifacts)
        ? Effect.succeed(undefined)
        : artifacts.value.head(reader.canvasName, id).pipe(
            Effect.map((head): Found => (Option.isSome(head) ? { title: head.value.artifact.title, nodeId: head.value.artifact.nodeId as NodeId } : null)),
            Effect.orElseSucceed((): Found => undefined),
          );
    for (const link of links) {
      const node = canvas.nodes.get(link.target.nodeId);
      const itemKind = briefingItemKind(link.target, node?.kind);
      if (itemKind === undefined) {
        const facts: BriefingLinkFacts = {
          node: node === undefined ? undefined : { kind: node.kind, title: titleOf(node), reachable: canAct(canvas, self, node.id) },
        };
        mentions.push(briefingMentionOf(link, facts));
        continue;
      }
      const id = link.target.item!;
      // A task board's item is its task; anything else, or a task the board does not hold, is an artifact by its id:
      // artifacts move, so the node in the link is only a hint.
      const asTask = itemKind === "task" ? yield* task(id) : null;
      const kind = asTask === null ? "artifact" : "task";
      const found = asTask === null ? yield* artifact(id) : asTask;
      // No store, or a read that failed: nothing here can say the item is gone.
      if (found === undefined) return undefined;
      // Reach is judged where the item lives, as task and artifact control judge it, not where the link says.
      const held = found === null ? undefined : canvas.nodes.get(found.nodeId);
      mentions.push(briefingMentionOf(link, {
        node: undefined,
        item: found === null || held === undefined ? undefined : { kind, title: found.title, reachable: canAct(canvas, self, held.id) },
      }));
    }
    return mentions;
  });

/** The mentions in `text`, reading the reader's canvas from the model. */
export const briefingMentions = (
  reader: BriefingReader,
  text: string,
): Effect.Effect<ReadonlyArray<BriefingMention> | undefined> =>
  Effect.gen(function* () {
    if (briefingLinksOf(text).length === 0) return undefined;
    const model = yield* Effect.serviceOption(ModelService);
    if (Option.isNone(model)) return undefined;
    const canvas = yield* Effect.option(model.value.canvas(reader.canvasName));
    if (Option.isNone(canvas)) return undefined;
    return yield* briefingMentionsOn(canvas.value, reader, text);
  });

/** `{ mentions }` when the text links something that could be read, else nothing: spread beside the text. */
export const mentionsField = (
  mentions: ReadonlyArray<BriefingMention> | undefined,
): { readonly mentions?: ReadonlyArray<BriefingMention> } => (mentions === undefined ? {} : { mentions });
