/**
 * Grok clipboard preflight — abort paste when an image is on the pasteboard.
 * Never clears the operator's clipboard (plan §4).
 */

import { execFileSync } from "node:child_process";

const IMAGE_CLIPBOARD =
  /PNG|TIFF|JPEG|JPG|GIF|BMP|public\.png|public\.tiff|public\.jpeg|public\.gif|NeXT TIFF|«class PNGf»|«class TIFF»/i;

/**
 * Returns false when the system clipboard reports an image type.
 * Non-darwin: always true (no osascript). Probe errors fail open (true) so a
 * broken osascript cannot permanently brick typing — image risk is macOS/Grok.
 */
export const assertMacClipboardSafeForPaste = (): boolean => {
  if (process.platform !== "darwin") return true;
  try {
    const out = execFileSync(
      "osascript",
      ["-e", "clipboard info"],
      {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 64 * 1024,
      },
    );
    if (IMAGE_CLIPBOARD.test(out)) return false;
    return true;
  } catch {
    // Fail open on probe failure — do not clear clipboard, do not block forever.
    return true;
  }
};
