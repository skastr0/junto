/**
 * A save too large to send to another machine's node (0.12.1, X3, remote-
 * lead's point b): said in remote-design's words. The draft stays because
 * FilesNode's write clears it only on a save that succeeded.
 */
import { describe, expect, it } from "vitest";
import { filesErrorLine, REMOTE_SAVE_TOO_LARGE_LINE, saveErrorLine } from "../src/window/lib/files-source";

describe("a refused save in Junto's words", () => {
  it("says a remote save over one frame is too large to save from here, with the changes kept and the far file unchanged", () => {
    expect(REMOTE_SAVE_TOO_LARGE_LINE).toBe(
      "This file is too large to save from this machine. Your changes are still here, and the file on its machine is unchanged.",
    );
    expect(saveErrorLine("too-large", false)).toBe(REMOTE_SAVE_TOO_LARGE_LINE);
    expect(REMOTE_SAVE_TOO_LARGE_LINE).not.toContain(String.fromCharCode(0xb7));
  });

  it("keeps the shared words for a local save and for every other refusal", () => {
    expect(saveErrorLine("too-large", true)).toBe(filesErrorLine("too-large"));
    expect(saveErrorLine("denied", false)).toBe(filesErrorLine("denied"));
  });
});
