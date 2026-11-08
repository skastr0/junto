/**
 * The window's content group (src/contract/window/content.ts) as promises,
 * for the stores and helpers that write through it: the operator's attachment
 * pieces, an image put, and the portrait overrides. A component reads them
 * with `useContentCalls` and hands them on; undefined with no runtime above
 * (a card drawn alone in a test), and then nothing is written.
 *
 * Each call reads the group's client from the runtime when it is made, so a
 * runtime without it (a test's own) refuses the call rather than the render.
 * A piece is decoded here first, as the group's schema reads it. A put that
 * does not decode, or whose call fails (a payload main refused, or a link
 * that is gone), answers its refusal in words, as a put the core refused does.
 */
import { useContext, useMemo } from "react";
import { Effect, Schema } from "effect";
import { OperatorContentPut, type OperatorContentPutResult } from "@shared/operator-attachments";
import type { PortraitOverride, PortraitOverrides, PortraitOverrideSetResult } from "@shared/portrait-overrides";
import type { ContentPutImageInput, ContentPutImageResult } from "../../contract/core/content";
import { ContentWindow } from "../../contract/window/content";
import { WindowRuntimeContext, type WindowRuntime } from "../rpc/runtime";

export type ContentCalls = {
  readonly operatorPut: (input: OperatorContentPut) => Promise<OperatorContentPutResult>;
  readonly putImage: (input: ContentPutImageInput) => Promise<ContentPutImageResult>;
  /** Every saved override; rejects when the store could not be read. */
  readonly portraitOverrides: () => Promise<PortraitOverrides>;
  /** One seat's override, or null to reset it; rejects when the call could not be made. */
  readonly portraitOverrideSet: (seatId: string, override: PortraitOverride | null) => Promise<PortraitOverrideSetResult>;
};

export const contentCalls = (runtime: WindowRuntime): ContentCalls => ({
  operatorPut: (input) =>
    runtime
      .runPromise(
        Effect.flatMap(Schema.decodeUnknownEffect(OperatorContentPut)(input), (piece) =>
          Effect.flatMap(ContentWindow, (content) => content.ContentOperatorPut(piece)),
        ),
      )
      .catch((): OperatorContentPutResult => ({ ok: false, message: "That piece of the file could not be stored." })),
  putImage: (input) =>
    runtime
      .runPromise(Effect.flatMap(ContentWindow, (content) => content.ContentPutImage(input)))
      .catch((): ContentPutImageResult => ({ ok: false, error: "The image could not be stored." })),
  portraitOverrides: () => runtime.runPromise(Effect.flatMap(ContentWindow, (content) => content.ContentPortraitOverrides())),
  portraitOverrideSet: (seatId, override) =>
    runtime.runPromise(Effect.flatMap(ContentWindow, (content) => content.ContentPortraitOverrideSet({ seatId, override }))),
});

/** The content calls on the window's runtime, or undefined with no runtime above. */
export const useContentCalls = (): ContentCalls | undefined => {
  const runtime = useContext(WindowRuntimeContext);
  return useMemo(() => (runtime === undefined ? undefined : contentCalls(runtime)), [runtime]);
};
