/**
 * What the window writes and stages through the content core: the operator's
 * attachment pieces, an image put, and the portrait overrides. Every handler
 * asks the core's content group (src/contract/core/content.ts); what the
 * window sends is decoded here, so the core is only handed what it can read.
 * A portrait save is broadcast as it stands, after the call.
 *
 * Returns the one call another handler of main makes through the same group:
 * the operator's purge of a page box comment's shot, which runs under the
 * main-authoring gate that handler holds.
 */
import type { IpcMain } from "electron";
import { Context, Result, Schema } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import { OperatorContentPut, type OperatorContentPutResult } from "@shared/operator-attachments";
import type { PageShotPurged, PageShotPurgeRequest } from "@shared/page-shot";
import {
  normalizePortraitOverride,
  PortraitSeatId,
  type PortraitOverrideSetResult,
} from "@shared/portrait-overrides";
import { ContentCore, ContentPutImageInput, type ContentPutImageResult } from "../../contract/core/content";
import { AppRuntime } from "../runtime";

const closed = { onExcessProperty: "error" } as const;
const decodeOperatorPut = Schema.decodeUnknownResult(OperatorContentPut, closed);
const decodePutImage = Schema.decodeUnknownResult(ContentPutImageInput, closed);
const decodeSeatId = Schema.decodeUnknownResult(PortraitSeatId);

export type ContentAsks = {
  /** The operator's purge of a page box comment's shot. */
  readonly purgePageShot: (comment: PageShotPurgeRequest) => Promise<PageShotPurged>;
};

export const registerContentIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: unknown) => void,
  core: Context.Context<ContentCore>,
): ContentAsks => {
  const content = Context.get(core, ContentCore);

  // A file the operator attaches to mail, one piece at a time, staged as the
  // operator; the mail that names it claims it.
  ipc.handle(IPC_CHANNELS.operatorContentPut, (_event, input: unknown): Promise<OperatorContentPutResult> => {
    const decoded = decodeOperatorPut(input);
    if (Result.isFailure(decoded)) return Promise.resolve({ ok: false, message: "That piece of the file could not be read." });
    return AppRuntime.runPromise(content.ContentOperatorPut(decoded.success));
  });

  // Portrait overrides: the operator's per-seat character customization. An
  // install-local preference like settings (no canvas authoring), so it runs
  // outside the main-authoring gate; every change is broadcast as it stands.
  ipc.handle(IPC_CHANNELS.portraitOverridesList, () => AppRuntime.runPromise(content.ContentPortraitOverrides()));
  ipc.handle(
    IPC_CHANNELS.portraitOverrideSet,
    async (_event, seatId: unknown, override: unknown): Promise<PortraitOverrideSetResult> => {
      const named = decodeSeatId(seatId);
      if (Result.isFailure(named)) return { ok: false, message: "portrait seat id is invalid" };
      try {
        const saved = await AppRuntime.runPromise(
          content.ContentPortraitOverrideSet({
            seatId: named.success,
            override: override === null ? null : normalizePortraitOverride(override),
          }),
        );
        if (saved.ok) broadcast(IPC_CHANNELS.portraitOverride, { seatId: saved.seatId, override: saved.override });
        return saved;
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "portrait save failed" };
      }
    },
  );

  // Image content put: canvas image nodes and note embeds. The content store
  // only; the document carries ContentRef URLs, never Base64.
  ipc.handle(IPC_CHANNELS.contentPutImage, (_event, input: unknown): Promise<ContentPutImageResult> => {
    const decoded = decodePutImage(input);
    if (Result.isFailure(decoded)) return Promise.resolve({ ok: false, error: "invalid image put input" });
    return AppRuntime.runPromise(content.ContentPutImage(decoded.success));
  });

  return {
    purgePageShot: (comment) => AppRuntime.runPromise(content.ContentPageShotPurge(comment)),
  };
};
