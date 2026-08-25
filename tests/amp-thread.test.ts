import { describe, expect, it } from "vitest";
import {
  isAmpThreadId,
  parseAmpThreadReceipt,
  provisionAmpThread,
} from "../src/main/vellum/term/templates/amp-thread";

// The receipt shape below is real output from
// `amp threads new --visibility private` on 0.0.1787664850.
const REAL_RECEIPT = "T-01a03989-71a6-733b-ac4c-76f54969cb55\n";

describe("amp thread receipts", () => {
  it("accepts the id Amp actually prints", () => {
    expect(parseAmpThreadReceipt(REAL_RECEIPT)).toBe(
      "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    );
    expect(isAmpThreadId("T-01a03989-71a6-733b-ac4c-76f54969cb55")).toBe(true);
  });

  it("reads the id out of surrounding chatter", () => {
    expect(
      parseAmpThreadReceipt(
        ["A new version of Amp is available.", REAL_RECEIPT.trim(), ""].join("\n"),
      ),
    ).toBe("T-01a03989-71a6-733b-ac4c-76f54969cb55");
  });

  it("refuses anything that is not exactly one id", () => {
    expect(parseAmpThreadReceipt("")).toBeUndefined();
    expect(parseAmpThreadReceipt("no thread here")).toBeUndefined();
    // Two ids: guessing which one is the receipt would durably pin the seat to
    // the wrong thread.
    expect(
      parseAmpThreadReceipt(
        [
          "T-01a03989-71a6-733b-ac4c-76f54969cb55",
          "T-019ffd00-6549-7498-b9ed-5d4dc405c9d6",
        ].join("\n"),
      ),
    ).toBeUndefined();
    expect(isAmpThreadId("T-not-a-uuid")).toBe(false);
    expect(isAmpThreadId("019ffd00-6549-7498-b9ed-5d4dc405c9d6")).toBe(false);
  });
});

describe("provisionAmpThread", () => {
  it("asks the public CLI for a private thread, with no shell", async () => {
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    const result = await provisionAmpThread({
      run: async (binary, args) => {
        calls.push({ binary, args });
        return REAL_RECEIPT;
      },
    });
    expect(result).toEqual({
      ok: true,
      threadId: "T-01a03989-71a6-733b-ac4c-76f54969cb55",
    });
    expect(calls).toEqual([
      { binary: "amp", args: ["threads", "new", "--visibility", "private"] },
    ]);
  });

  it("surfaces an auth or network failure instead of falling back", async () => {
    const result = await provisionAmpThread({
      run: async () => {
        throw new Error("Not logged in");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("amp_thread_unprovisioned");
    expect(result.failure.reason).toContain("Not logged in");
  });

  it("surfaces an unreadable receipt rather than inventing an id", async () => {
    const result = await provisionAmpThread({ run: async () => "created ok" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toContain("exactly one thread id");
  });
});
