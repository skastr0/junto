/**
 * A subject's comments as the phone reads and writes them: the desktop's own
 * read (`listThreads`) and its one artifact comment path (`commentOnArtifact`),
 * so a comment posted from the phone is written, mentioned and announced
 * exactly as one posted on the desktop.
 *
 * The phone names the artifact by its id; where it sits is the head's own
 * answer, so a comment still lands on an artifact that has moved since the
 * phone read it. A write runs under the main authoring gate as
 * `companion.comment`, and a replayed opId answers as the first one did.
 */
import { Effect, Option, Result, Schema } from "effect";
import type { WorkErrorBody } from "@shared/work-control";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import { companionCommentsPage } from "@shared/companion-comments";
import { ThreadPostDraft } from "@shared/resource-ipc";
import type { ItemId } from "@shared/wire/ids";
import { CompanionRuntime } from "./runtime";
import { mainAuthoringGate } from "../main-authoring-gate";
import { commentOnArtifact } from "../work/artifact-control";
import { listThreads, liveResourceIpcPorts } from "../work/resource-ipc";
import { WorkService } from "../work/service";

/** The ports the desktop's own resource reads use, over this app's work plane. */
const ports = liveResourceIpcPorts(
  (canvasName) =>
    Effect.tryPromise({
      try: () => CompanionRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readTopology(canvasName))),
      catch: (): WorkErrorBody => ({
        type: "InternalError",
        message: `canvas ${canvasName} could not be read`,
        details: { retryable: true },
      }),
    }).pipe(Effect.map((read) => read.canvas)),
  (canvasName, nodeId) =>
    Effect.tryPromise({
      try: () => CompanionRuntime.runPromise(Effect.flatMap(WorkService, (work) => work.readMailbox(canvasName, nodeId))),
      catch: (): WorkErrorBody => ({
        type: "InternalError",
        message: `the comments on ${nodeId} could not be read`,
        details: { retryable: true },
      }),
    }),
);

const NOT_ON_CANVAS = "That artifact is not on this canvas.";

/** The artifact's head, wherever it has moved to; a canvas that does not hold it is not-found. */
const headOf = (canvasName: string, artifactId: ItemId) =>
  ports.artifacts.head(canvasName, artifactId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail<WorkErrorBody>({ type: "UnknownTarget", message: NOT_ON_CANVAS, details: { retryable: false } }),
        onSome: (head) => Effect.succeed(head),
      }),
    ),
  );

/** The desktop path's refusal as the phone reads it: a missing thing is not-found, anything else is invalid. */
const refused = (error: WorkErrorBody): CompanionOutcome<never> =>
  outcomeFail(error.type === "UnknownTarget" ? "not-found" : "invalid", error.message);

const unreadable = (): CompanionOutcome<never> => outcomeFail("internal", "The comments could not be read.");

export const companionCommentBackend: Pick<CompanionBackend, "comments" | "comment"> = {
  comments: async (args) => {
    const read = await CompanionRuntime.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const head = yield* headOf(args.canvasName, args.subject.artifactId);
          const threads = yield* listThreads(ports, args.canvasName, {
            kind: "artifact",
            nodeId: head.artifact.nodeId,
            artifactId: head.artifact.artifactId,
          });
          return companionCommentsPage(threads, {
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            ...(args.before === undefined ? {} : { before: args.before }),
          });
        }),
      ),
    ).catch(() => undefined);
    if (read === undefined) return unreadable();
    return Result.isSuccess(read) ? outcomeOk(read.success) : refused(read.failure);
  },

  comment: async (args) => {
    const decoded = Schema.decodeUnknownResult(ThreadPostDraft, { onExcessProperty: "error" })({
      opId: args.opId,
      text: args.text,
      ...(args.anchor === undefined ? {} : { anchor: args.anchor }),
      ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
    });
    if (Result.isFailure(decoded)) return outcomeFail("invalid", "That comment could not be read.");
    const post = decoded.success;
    const written = await mainAuthoringGate
      .run("companion.comment", () =>
        CompanionRuntime.runPromise(
          Effect.result(
            Effect.gen(function* () {
              const canvas = yield* ports.topology(args.canvasName);
              yield* headOf(args.canvasName, args.subject.artifactId);
              return yield* commentOnArtifact({ canvas, canvasName: args.canvasName, actor: { kind: "operator" } }, ports.artifacts, {
                opId: post.opId,
                artifact: args.subject.artifactId,
                text: post.text,
                ...(post.anchor === undefined ? {} : { anchor: post.anchor }),
                ...(post.threadId === undefined ? {} : { threadId: post.threadId }),
              });
            }),
          ),
        ),
      )
      .catch(() => undefined);
    if (written === undefined) return outcomeFail("internal", "That comment could not be written.");
    if (Result.isFailure(written)) return refused(written.failure);
    const ruled = written.success;
    return outcomeOk({
      threadId: ruled.threadId,
      messageId: ruled.messageId,
      ...(ruled.unlinked === undefined ? {} : { unlinked: ruled.unlinked }),
    });
  },
};
