/**
 * The phone's mention picker, on the desktop's one rule
 * (`src/shared/mention-candidates.ts`): the scope is `mentionableNodesFrom`,
 * the items are a task board's tasks and an Artifacts node's artifacts as the
 * canvas holds them, and the query narrows them with `filterCandidates`.
 *
 * A read only: it names what could be linked, never writes one.
 */
import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { asNodeId, type Canvas } from "@shared/model";
import { outcomeFail, outcomeOk, type CompanionBackend } from "@shared/companion-core";
import {
  candidatesOfNodes,
  connectedSeatCandidates,
  filterCandidates,
  type MentionItem,
  type NamedMentionCandidate,
} from "@shared/mention-candidates";
import { mentionableNodesFrom } from "@shared/mention-reach";
import { COMPANION_MENTION_CANDIDATES_MAX, type CompanionMentionCandidate } from "@shared/wire/companion-artifacts";
import { AppRuntime } from "../../runtime";
import { ModelService } from "../model/service";
import { withSqlRead } from "../state/sql-read";
import { ArtifactRepository } from "../work/artifact-repository";
import { readTasksByNode } from "../work/seat-task-read";
import { mentionableSeats } from "../work/operator-threads";
import { TaskRepository } from "../work/task-repository";

type CanvasItems = {
  readonly canvas: Canvas;
  readonly tasksOf: ReadonlyMap<string, ReadonlyArray<MentionItem>>;
  readonly artifactsOf: ReadonlyMap<string, ReadonlyArray<MentionItem>>;
};

/** The canvas and the items its task boards and Artifacts nodes hold; undefined when there is no such canvas. */
const canvasItems = (canvasName: string): Promise<CanvasItems | undefined> =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const model = yield* ModelService;
      const tasks = yield* TaskRepository;
      const artifacts = yield* ArtifactRepository;
      const sql = yield* SqlClient.SqlClient;
      const read = yield* withSqlRead(sql, model.canvas(canvasName));
      const tasksOf = new Map<string, ReadonlyArray<MentionItem>>();
      const artifactsOf = new Map<string, ReadonlyArray<MentionItem>>();
      const byNode = yield* withSqlRead(sql, readTasksByNode(tasks, read)).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, ReadonlyArray<{ taskId: string; title: string; number?: number; current: { state: string } }>>())),
      );
      for (const [nodeId, held] of byNode) {
        tasksOf.set(
          nodeId,
          held.map((task) => ({
            id: task.taskId,
            title: task.title,
            ...(task.number === undefined ? {} : { number: task.number }),
            note: task.current.state,
          })),
        );
      }
      for (const node of read.nodes.values()) {
        if (node.kind !== "artifacts") continue;
        const listed = yield* artifacts.list(canvasName, { nodeIds: [node.id], archived: false, limit: 200 }).pipe(Effect.result);
        if (Result.isFailure(listed)) continue;
        artifactsOf.set(
          node.id,
          listed.success.artifacts
            .filter((entry) => !entry.archived)
            .map((entry) => ({ id: entry.artifactId, title: entry.title })),
        );
      }
      return { canvas: read, tasksOf, artifactsOf } satisfies CanvasItems;
    }).pipe(Effect.catch(() => Effect.succeed(undefined))),
  );

/** The seats wired to this one, an `@` from a seat: read on the canvas's own wires. */
const connectedSeats = (canvasName: string, nodeId: string) =>
  AppRuntime.runPromise(mentionableSeats(canvasName, nodeId).pipe(Effect.catch(() => Effect.succeed([]))));

/** A candidate as the phone reads it: kind, label, bare title, and where it sits when that is not the label. */
const wireCandidate = (candidate: NamedMentionCandidate): CompanionMentionCandidate => ({
  ref: candidate.ref,
  kind: candidate.ref.kind,
  label: candidate.label.slice(0, 320),
  title: candidate.title.slice(0, 320),
  ...(candidate.detail === undefined ? {} : { subtitle: candidate.detail.slice(0, 320) }),
  ...(candidate.note === undefined ? {} : { note: candidate.note.slice(0, 320) }),
});

export const companionMentionBackend: Pick<CompanionBackend, "mentionCandidates"> = {
  mentionCandidates: async (args) => {
    const items = await canvasItems(args.canvasName);
    if (items === undefined) return outcomeFail("not-found", "No such canvas.");
    const from = asNodeId(args.from);
    if (items.canvas.nodes.get(from) === undefined) return outcomeFail("not-found", "That node is not on this canvas.");
    const seats = await connectedSeats(args.canvasName, from);
    const candidates = [
      ...connectedSeatCandidates(seats),
      ...candidatesOfNodes(items.canvas, mentionableNodesFrom(items.canvas, from), {
        tasksOf: (nodeId) => items.tasksOf.get(nodeId) ?? [],
        artifactsOf: (nodeId) => items.artifactsOf.get(nodeId) ?? [],
      }),
    ];
    const narrowed = filterCandidates(candidates, { trigger: args.trigger, query: args.query ?? "" })
      .flatMap((candidate) => (candidate.title === undefined ? [] : [wireCandidate({ ...candidate, title: candidate.title })]));
    const limit = Math.min(args.limit ?? COMPANION_MENTION_CANDIDATES_MAX, COMPANION_MENTION_CANDIDATES_MAX);
    return outcomeOk({ candidates: narrowed.slice(0, limit) });
  },
};
