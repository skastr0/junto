import { afterEach, describe, expect, it, vi } from "vitest";
import { answerConfirm, askConfirm, confirm$ } from "../src/renderer/lib/confirm";

const question = (source: string) => ({ source, title: "Delete this?", confirmLabel: "Delete" });

describe("askConfirm", () => {
  afterEach(() => {
    answerConfirm(false);
    vi.restoreAllMocks();
  });

  it("resolves true only when the operator confirms", async () => {
    const asked = askConfirm(question("artifact-delete"));
    expect(confirm$.pending.peek()?.source).toBe("artifact-delete");
    answerConfirm(true);
    expect(await asked).toBe(true);
    expect(confirm$.pending.peek()).toBeNull();
  });

  it("resolves false on cancel", async () => {
    const asked = askConfirm(question("artifact-delete"));
    answerConfirm(false);
    expect(await asked).toBe(false);
  });

  it("refuses a second ask while one is open, and says who asked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = askConfirm(question("node-delete"));
    expect(await askConfirm(question("edge-delete"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("edge-delete");
    expect(String(warn.mock.calls[0]?.[0])).toContain("node-delete");
    // The first question is untouched.
    expect(confirm$.pending.peek()?.source).toBe("node-delete");
    answerConfirm(true);
    expect(await first).toBe(true);
  });

  it("asks again after an answer", async () => {
    const first = askConfirm(question("a"));
    answerConfirm(false);
    await first;
    const second = askConfirm(question("b"));
    answerConfirm(true);
    expect(await second).toBe(true);
  });
});
