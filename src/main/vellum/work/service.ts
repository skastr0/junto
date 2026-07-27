// WorkService — durable work-plane mutations over SQLite.
// The authorial canvas is read only for topology/kind/home validation. Existing
// callers receive a temporary work projection; it is never committed as intent.

import { Context, Effect, Layer, Schema } from "effect";
import type {
  WorkMetadata,
  Task,
  Artifact,
  CanvasDoc,
  Message,
  TaskState,
} from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import {
  WorkError,
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskCreate,
  workTaskDescribe,
  workTaskTransition,
  type WorkIds,
} from "@shared/work";
import { CanvasesService, CanvasError } from "../canvases";
import { resolveNodeHostId } from "@shared/station";
import { StationRepository } from "../station/repository";
import { clearSeatBlockedByRequest } from "./blocked-seat";
import { messageDelivery } from "./message-delivery";
import {
  COMMAND_CENTER_WORK_HOME,
  WorkRepository,
  WorkRepositoryError,
  type WorkCommandStatus,
} from "./repository";
import { ulid } from "ulid";

export class WorkServiceError extends Schema.TaggedError<WorkServiceError>()("WorkServiceError", {
  code: Schema.Literal(
    "canvas_not_found",
    "node_not_found",
    "task_not_found",
    "illegal_kind",
    "illegal_transition",
    "claim_contention",
    "invalid",
  ),
  message: Schema.String,
}) {}

export type { WorkOpResult };

const defaultIds = (): WorkIds => ({
  id: () => ulid(),
  messageId: () => ulid(),
});

const toWorkServiceError = (error: unknown): WorkServiceError => {
  if (error instanceof WorkError) {
    return new WorkServiceError({ code: error.code, message: error.message });
  }
  if (error instanceof WorkServiceError) return error;
  if (error instanceof WorkRepositoryError) {
    return new WorkServiceError({ code: "invalid", message: error.message });
  }
  if (error instanceof CanvasError) {
    const msg = error.message;
    if (msg.includes("ENOENT") || msg.includes("no such file") || msg.includes("does not exist")) {
      return new WorkServiceError({ code: "canvas_not_found", message: msg });
    }
    return new WorkServiceError({ code: "invalid", message: msg });
  }
  return new WorkServiceError({
    code: "invalid",
    message: error instanceof Error ? error.message : String(error),
  });
};

type WorkApplyOk<T> = {
  readonly value: T;
  readonly doc: CanvasDoc;
  readonly revision: string;
  readonly disposition: "applied" | "queued";
};

const asResult = <T>(
  effect: Effect.Effect<WorkApplyOk<T>, WorkServiceError>,
): Effect.Effect<WorkOpResult<T>> =>
  effect.pipe(
    Effect.map(
      ({ value, doc, revision, disposition }): WorkOpResult<T> => ({
        ok: true,
        data: value,
        doc,
        revision,
        disposition,
      }),
    ),
    Effect.catchAll((err) =>
      Effect.succeed({
        ok: false as const,
        code: err.code,
        message: err.message,
      }),
    ),
  );

export class WorkService extends Context.Tag("@vellum/WorkService")<
  WorkService,
  {
    readonly workTaskCreate: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      reason?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskDescribe: (
      canvas: string,
      nodeId: string,
      taskId: string,
      brief: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskTransition: (
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workTaskClaim: (
      canvas: string,
      nodeId: string,
      taskId: string,
      actor: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workMessageAppend: (
      canvas: string,
      nodeId: string,
      taskId: string | null,
      message: Message,
    ) => Effect.Effect<WorkOpResult<Message>>;
    readonly workRequestCreate: (
      canvas: string,
      nodeId: string,
      brief: string,
      metadata?: WorkMetadata,
      raisedBy?: string,
      reason?: string,
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workRequestResolve: (
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "completed" | "rejected",
    ) => Effect.Effect<WorkOpResult<Task>>;
    readonly workArtifactPublish: (
      canvas: string,
      nodeId: string,
      artifact: Artifact,
    ) => Effect.Effect<WorkOpResult<Artifact>>;
    readonly commandStatus: Effect.Effect<
      WorkCommandStatus,
      WorkServiceError
    >;
  }
>() {}

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const repository = yield* WorkRepository;
    const stations = yield* StationRepository;
    const ids = defaultIds();

    const apply = <T>(
      canvas: string,
      nodeId: string,
      operation: string,
      fn: (doc: CanvasDoc) => { doc: CanvasDoc; value: T },
      options: { readonly messageHome?: boolean } = {},
    ): Effect.Effect<WorkApplyOk<T>, WorkServiceError> =>
      Effect.gen(function* () {
        const eventHome = yield* stations.installationId.pipe(
          Effect.mapError(toWorkServiceError),
        );
        const station = yield* stations.configuration.pipe(
          Effect.mapError(toWorkServiceError),
        );
        if (station === undefined) {
          return yield* new WorkServiceError({
            code: "invalid",
            message:
              "station role is not configured; choose Command Center or Remote before mutating work",
          });
        }
        if (
          options.messageHome &&
          station.configuration.role === "remote"
        ) {
          return yield* new WorkServiceError({
            code: "invalid",
            message:
              "messages are Command-Center-homed and cannot be authored on a Remote",
          });
        }
        const read = yield* canvases
          .read(canvas)
          .pipe(Effect.mapError(toWorkServiceError));
        const node = read.doc.nodes.find((candidate) => candidate.id === nodeId);
        if (!node) {
          return yield* new WorkServiceError({
            code: "node_not_found",
            message: `node "${nodeId}" not found`,
          });
        }
        const entityHome = options.messageHome
          ? COMMAND_CENTER_WORK_HOME
          : resolveNodeHostId(node);
        if (
          station.configuration.role === "remote" &&
          entityHome !== station.configuration.hostId
        ) {
          return yield* new WorkServiceError({
            code: "invalid",
            message:
              `Remote "${station.configuration.hostId}" cannot mutate work homed on "${entityHome}"`,
          });
        }
        const result = yield* repository
          .mutate({
            canvasName: canvas,
            nodeId,
            entityHome,
            eventHome,
            materialization:
              station.configuration.role === "command-center" &&
                !options.messageHome &&
                entityHome !== station.configuration.hostId
                ? "on-disposition"
                : "immediate",
            operation,
            authoredDoc: read.doc,
            transform: fn,
          })
          .pipe(Effect.mapError(toWorkServiceError));
        return {
          value: result.value,
          doc: result.projectedDoc,
          // Work mutations do not advance authorial canvas revision.
          revision: read.revision,
          disposition: result.disposition,
        };
      });

    return WorkService.of({
      workTaskCreate: (canvas, nodeId, brief, metadata, reason) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "task.create",
            (doc) => {
              const result = workTaskCreate(
                doc,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                reason,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ),

      workTaskDescribe: (canvas, nodeId, taskId, brief) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "task.describe",
            (doc) => {
              const result = workTaskDescribe(
                doc,
                canvas,
                nodeId,
                taskId,
                brief,
                ids,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ),

      workTaskTransition: (canvas, nodeId, taskId, state, note) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "task.transition",
            (doc) => {
              const result = workTaskTransition(
                doc,
                canvas,
                nodeId,
                taskId,
                state,
                note,
                ids,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ),

      workTaskClaim: (canvas, nodeId, taskId, actor) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "task.claim",
            (doc) => {
              const result = workTaskClaim(
                doc,
                canvas,
                nodeId,
                taskId,
                actor,
                ids,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ),

      workMessageAppend: (canvas, nodeId, taskId, message) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "message.append",
            (doc) => {
              const result = workMessageAppend(
                doc,
                canvas,
                nodeId,
                taskId,
                message,
              );
              return { doc: result.doc, value: result.message };
            },
            { messageHome: taskId === null },
          ),
        ).pipe(
          Effect.tap((result) => {
            // Nudge channel: only actor inboxes (taskId null).
            // Task/request history is a pull surface — never auto-delivered.
            if (result.ok && taskId === null) {
              messageDelivery.notifyAppended(canvas, nodeId, result.data);
            }
            return Effect.void;
          }),
        ),

      workRequestCreate: (canvas, nodeId, brief, metadata, raisedBy, reason) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "request.create",
            (doc) => {
              const result = workRequestCreate(
                doc,
                canvas,
                nodeId,
                brief,
                metadata,
                ids,
                raisedBy,
                reason,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ),

      workRequestResolve: (canvas, nodeId, taskId, responseText, disposition) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "request.resolve",
            (doc) => {
              const result = workRequestResolve(
                doc,
                canvas,
                nodeId,
                taskId,
                responseText,
                disposition,
                ids,
              );
              return { doc: result.doc, value: result.task };
            },
          ),
        ).pipe(
          Effect.tap((result) => {
            // Escalate seats clear when the operator answers the request.
            if (result.ok) {
              clearSeatBlockedByRequest(canvas, taskId);
            }
            return Effect.void;
          }),
        ),

      workArtifactPublish: (canvas, nodeId, artifact) =>
        asResult(
          apply(
            canvas,
            nodeId,
            "artifact.publish",
            (doc) => {
              const result = workArtifactPublish(
                doc,
                canvas,
                nodeId,
                artifact,
              );
              return { doc: result.doc, value: result.artifact };
            },
          ),
        ),
      commandStatus: repository.commandStatus.pipe(
        Effect.mapError(toWorkServiceError),
      ),
    });
  }),
);
