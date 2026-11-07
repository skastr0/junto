/**
 * Main's side of the phone companion's clipboard: the system clipboard, which
 * is main's, is served to the core by host operation. A pairing that ends
 * takes its link off the clipboard only if the clipboard still holds it,
 * which main checks. Settings reaches the companion itself through the
 * core's companion group (`contract/core/companion.ts`).
 */
import type { CompanionClipboard } from "../../../core/companion/service";
import type { HostOp } from "../../../core/host-ops";
import { hostOps } from "./host-op-bodies";

declare module "../../../core/host-ops" {
  interface HostOps {
    "clipboard.write": HostOp<{ readonly text: string }, void>;
    /** Clears the clipboard only while it still holds `text`. */
    "clipboard.clearIf": HostOp<{ readonly text: string }, void>;
  }
}

/** Main's side: the system clipboard for the core's Copy link. Returns the removal. */
export const serveCompanionClipboard = (clipboard: CompanionClipboard): (() => void) =>
  hostOps({
    "clipboard.write": async ({ text }) => clipboard.writeText(text),
    "clipboard.clearIf": async ({ text }) => {
      if (clipboard.readText() === text) clipboard.clear();
    },
  });
