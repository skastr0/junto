/**
 * Main's side of the drive's paste preflight.
 *
 * The clipboard is Electron's, so main reads the pasteboard's formats and the
 * core asks whether a Grok seat may take what it holds. The check is metadata
 * only (`term/drive/clipboard-safe.ts`): reading the contents, on macOS, asks
 * ImageIO to decode the payloads.
 */
import { clipboardFormatsAreSafeForGrok } from "../../junto/term/drive/clipboard-safe";
import { hostOps, type HostOp } from "../host-ops";

declare module "../host-ops" {
  interface HostOps {
    /** Whether the pasteboard holds only formats a guarded seat can paste. */
    "clipboard.safeForGrok": HostOp<Record<string, never>, boolean>;
  }
}

/** What main reads of the system clipboard here: its formats, and nothing else. */
export type ClipboardFormats = {
  readonly availableFormats: () => ReadonlyArray<string>;
};

/** Main's side: the pasteboard as the paste preflight reads it. */
export const serveClipboardFormats = (clipboard: ClipboardFormats): (() => void) =>
  hostOps({
    "clipboard.safeForGrok": async () => clipboardFormatsAreSafeForGrok(clipboard.availableFormats()),
  });
