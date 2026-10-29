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
    for (const link of links) {
      const node = canvas.nodes.get(link.target.nodeId);
      const facts: BriefingLinkFacts = {
        node: node === undefined ? undefined : { kind: node.kind, title: titleOf(node), reachable: canAct(canvas, self, node.id) },
      };
      const itemKind = briefingItemKind(link.target, node?.kind);
      if (itemKind === undefined) {
        mentions.push(briefingMentionOf(link, facts));
        continue;
      }
      const id = link.target.item!;
      const item = itemKind === "task"
        ? Option.isNone(tasks)
          ? undefined
          : yield* Effect.option(tasks.value.get(reader.canvasName, id as string as TaskId).pipe(
              Effect.map((task) => (Option.isSome(task) ? { title: task.value.title, nodeId: task.value.current.node as NodeId } : null)),
            ))
        : Option.isNone(artifacts)
          ? undefined
          : yield* Effect.option(artifacts.value.head(reader.canvasName, id).pipe(
              Effect.map((head) => (Option.isSome(head) ? { title: head.value.artifact.title, nodeId: head.value.artifact.nodeId as NodeId } : null)),
            ));
      // No store, or a read that failed: nothing here can say the item is gone.
      if (item === undefined || Option.isNone(item)) return undefined;
      // Reach is judged where the item lives, as task and artifact control judge it, not where the link says.
      const held = item.value === null ? undefined : canvas.nodes.get(item.value.nodeId);
      mentions.push(briefingMentionOf(link, {
        node: held === undefined || node === undefined ? facts.node : { kind: node.kind, title: titleOf(node), reachable: canAct(canvas, self, held.id) },
        item: item.value === null || held === undefined ? undefined : { title: item.value.title },
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
