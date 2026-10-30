/**
 * The window's pixels as the overseer's capture answer. Main owns the window,
 * so this stays in main: the core asks for the pixels by host operation, and
 * this turns whatever the capture did into the answer the core takes.
 */
import type { ApplicationCaptureResult } from "./native";

/** The capture, as the overseer takes it: a PNG, or why there is none. */
export const captureTrustedWindowPng = (
  capture: () => Promise<Uint8Array | undefined>,
): (() => Promise<ApplicationCaptureResult>) =>
  async () => {
    try {
      const png = await capture();
      if (png === undefined) {
        return {
          ok: false,
          unavailable: true,
          reason: "no trusted Command Center window to observe",
        };
      }
      return { ok: true, png };
    } catch (error) {
      return {
        ok: false,
        unavailable: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };
