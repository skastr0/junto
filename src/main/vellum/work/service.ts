// WorkService — A2A work-plane mutations serialized through CanvasesService.mutate.
// All seven ops reject unknown canvas/node/task ids and illegal transitions.
// No silent writes. No dual shapes.

import { Context, Effect, Layer, Schema } from "effect";
import type {
  A2AMetadata,
  A2ATask,
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
  workTaskTransition,
  type WorkIds,
} from "@shared/a2a-work";
import { CanvasesService, CanvasError } from "../canvases";
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
};

const asResult = <T>(
  effect: Effect.Effect<WorkApplyOk<T>, WorkServiceError>,
): Effect.Effect<WorkOpResult<T>> =>
  effect.pipe(
    Effect.map(
      ({ value, doc, revision }): WorkOpResult<T> => ({
        ok: true,
        data: value,
        doc,
        revision,
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
      metadata?: A2AMetadata,
    ) => Effect.Effect<WorkOpResult<A2ATask>>;
    readonly workTaskTransition: (
      canvas: string,
      nodeId: string,
      taskId: string,
      state: TaskState,
      note?: string,
    ) => Effect.Effect<WorkOpResult<A2ATask>>;
    readonly workTaskClaim: (
      canvas: string,
      nodeId: string,
      taskId: string,
      actor: string,
    ) => Effect.Effect<WorkOpResult<A2ATask>>;
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
      metadata?: A2AMetadata,
    ) => Effect.Effect<WorkOpResult<A2ATask>>;
    readonly workRequestResolve: (
      canvas: string,
      nodeId: string,
      taskId: string,
      responseText: string,
      disposition: "completed" | "rejected",
    ) => Effect.Effect<WorkOpResult<A2ATask>>;
    readonly workArtifactPublish: (
      canvas: string,
      nodeId: string,
      artifact: Artifact,
    ) => Effect.Effect<WorkOpResult<Artifact>>;
  }
>() {}

export const WorkLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const canvases = yield* CanvasesService;
    const ids = defaultIds();

    // Serialize op body + capture return value under mutate's per-canvas mutex.
    // mutate re-applies fn on revision conflict — transforms must be idempotent
    // enough for create-with-fresh-id; create generates a new id each apply, so
    // we run the pure transform once, then write a fixed doc via mutate that
    // ignores the input if we already computed next. Safer: hold result outside
    // and use a single-shot transform.
    const apply = <T>(
      canvas: string,
      fn: (doc: CanvasDoc) => { doc: CanvasDoc; value: T },
    ): Effect.Effect<WorkApplyOk<T>, WorkServiceError> =>
      Effect.gen(function* () {
        // Read once, transform once, write with expected revision so concurrent
        // ops serialize via mutex and lose cleanly on conflict (retry).
        let lastError: WorkServiceError | undefined;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const read = yield* canvases.read(canvas).pipe(Effect.mapError(toWorkServiceError));
          let value: T;
          let nextDoc: CanvasDoc;
          try {
            const result = fn(read.doc);
            value = result.value;
            nextDoc = result.doc;
          } catch (error) {
            return yield* Effect.fail(toWorkServiceError(error));
          }
          const written = yield* canvases
            .write(canvas, nextDoc, read.revision)
            .pipe(Effect.either);
          if (written._tag === "Right") {
            return { value, doc: nextDoc, revision: written.right.revision };
          }
          const err = toWorkServiceError(written.left);
          // Revision conflict → retry; other errors fail.
          if (
            err.message.includes("changed on disk") ||
            err.message.includes("reload before saving")
          ) {
            lastError = err;
            continue;
          }
          return yield* Effect.fail(err);
        }
        return yield* Effect.fail(
          lastError ??
            new WorkServiceError({
              code: "invalid",
              message: `work op on "${canvas}" failed after retries`,
            }),
        );
      });

    return WorkService.of({
      workTaskCreate: (canvas, nodeId, brief, metadata) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workTaskCreate(doc, canvas, nodeId, brief, metadata, ids);
            return { doc: result.doc, value: result.task };
          }),
        ),

      workTaskTransition: (canvas, nodeId, taskId, state, note) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workTaskTransition(doc, canvas, nodeId, taskId, state, note, ids);
            return { doc: result.doc, value: result.task };
          }),
        ),

      workTaskClaim: (canvas, nodeId, taskId, actor) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workTaskClaim(doc, canvas, nodeId, taskId, actor, ids);
            return { doc: result.doc, value: result.task };
          }),
        ),

      workMessageAppend: (canvas, nodeId, taskId, message) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workMessageAppend(doc, canvas, nodeId, taskId, message);
            return { doc: result.doc, value: result.message };
          }),
        ),

      workRequestCreate: (canvas, nodeId, brief, metadata) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workRequestCreate(doc, canvas, nodeId, brief, metadata, ids);
            return { doc: result.doc, value: result.task };
          }),
        ),

      workRequestResolve: (canvas, nodeId, taskId, responseText, disposition) =>
        asResult(
          apply(canvas, (doc) => {
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
          }),
        ),

      workArtifactPublish: (canvas, nodeId, artifact) =>
        asResult(
          apply(canvas, (doc) => {
            const result = workArtifactPublish(doc, canvas, nodeId, artifact);
            return { doc: result.doc, value: result.artifact };
          }),
        ),
    });
  }),
);
