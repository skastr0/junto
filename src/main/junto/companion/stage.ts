/**
 * A phone's files on their way into the Mac content store (`content.stage`).
 *
 * The phone stages exactly as the desktop does (content/operator-attachments.ts):
 * through this process's stager, as the operator on the canvas, so the mail or
 * answer that names a file claims it with `claimOperatorAttachments` like any
 * other. The protocol half (offsets, the declared size, the per-phone count,
 * what unpairing lets go) is in `@shared/companion-core`; this is the store.
 */

import { Effect, Option } from "effect";
import { outcomeFail, outcomeOk, type CompanionBackend, type CompanionOutcome } from "@shared/companion-core";
import type { ContentStageResult } from "@shared/content-stage";
import { operatorActorRef } from "@shared/work-reference";
import { AppRuntime } from "../../runtime";
import { ModelService } from "../model/service";
import { ContentService } from "../content/service";
import { contentStageOwner, contentStagerFor, type ContentStageError, type ContentStageSeat } from "../content/stage";

/** The operator on a canvas: the seat the desktop stages as, and the claim reads. */
const operatorSeat = (canvasName: string): ContentStageSeat => ({
  canvasName,
  nodeId: operatorActorRef(canvasName).nodeId,
});

const STAGE_REFUSAL: Readonly<Record<ContentStageError["code"], CompanionOutcome<never>>> = {
  invalid: outcomeFail("invalid", "That piece could not be read."),
  "not-found": outcomeFail("invalid", "That upload is gone. Send the file again from the start."),
  "too-many": outcomeFail("rate-limited", "Too many files are uploading. Finish one first."),
  mismatch: outcomeFail("mismatch"),
  "disk-low": outcomeFail("disk-low"),
  failed: outcomeFail("internal"),
};

const canvasExists = (canvasName: string): Promise<boolean> =>
  AppRuntime.runPromise(
    Effect.flatMap(ModelService, (model) => model.listCanvases()).pipe(
      Effect.map((names) => names.some((name) => name === canvasName)),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );

export const companionStageBackend: Pick<CompanionBackend, "stagePiece" | "admitStage" | "dropStaged"> = {
  // The content store, not the canvas: as the desktop's own staging, no authoring gate.
  stagePiece: (canvasName, args) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const content = yield* Effect.serviceOption(ContentService);
        if (Option.isNone(content)) return outcomeFail<ContentStageResult>("unavailable", "The Mac's file store is not open.");
        const staged = yield* Effect.result(contentStagerFor(content.value).stage(operatorSeat(canvasName), args));
        return staged._tag === "Success" ? outcomeOk(staged.success) : STAGE_REFUSAL[staged.failure.code];
      }),
    ).catch(() => outcomeFail<ContentStageResult>("internal")),

  admitStage: async (canvasName, byteLength) => {
    if (!(await canvasExists(canvasName))) return outcomeFail("not-found", "No such canvas.");
    return AppRuntime.runPromise(
      Effect.gen(function* () {
        const content = yield* Effect.serviceOption(ContentService);
        if (Option.isNone(content)) return outcomeFail<void>("unavailable", "The Mac's file store is not open.");
        const admission = yield* content.value.admitWrite({ needBytes: byteLength }).pipe(Effect.option);
        return Option.isSome(admission) && admission.value.ok ? outcomeOk(undefined) : outcomeFail<void>("disk-low");
      }),
    ).catch(() => outcomeFail<void>("internal"));
  },

  dropStaged: (canvasName, stageId) =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const content = yield* Effect.serviceOption(ContentService);
        if (Option.isNone(content)) return;
        const seat = operatorSeat(canvasName);
        contentStagerFor(content.value).drop(seat, stageId);
        // Finished and not claimed: its stage hold goes; a claimed one has none left to let go.
        yield* content.value.releaseOwner(contentStageOwner(seat, stageId)).pipe(Effect.ignore);
      }),
    ).catch(() => undefined),
};
