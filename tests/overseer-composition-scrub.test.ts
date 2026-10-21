/**
 * The composition entry answers a seat even when the dispatcher's program
 * dies instead of failing: that answer is scrubbed like every other one.
 */
import { describe, expect, it } from "vitest";
import { composeOverseer } from "../src/main/junto/overseer/composition";

describe("an overseer program that dies, through onOverseer", () => {
  it("answers InternalError with the thrown secret scrubbed", async () => {
    // Every program this composition runs dies with an Error carrying a token,
    // the way a handler's unexpected throw reaches runPromise as a defect.
    const composition = await composeOverseer({
      run: async () => { throw new Error("handler died, Authorization: Bearer ghp_seatsecret123"); },
      captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "no window in test" }),
    });
    const answer = await composition.onOverseer(
      { operation: "agent.list", args: {} },
      { canvasName: "origin", nodeId: "boss" },
      new AbortController().signal,
    );
    expect(answer).toMatchObject({ ok: false, error: { type: "InternalError", message: expect.stringMatching(/^handler died/) } });
    expect(JSON.stringify(answer)).not.toContain("ghp_seatsecret123");
  });
});
