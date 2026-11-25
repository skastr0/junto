/**
 * The ThreadsMessages page crosses the core link under a strict encode: a
 * field the model carries and the wire does not name fails the whole read.
 * A thread an answered signal started carries `headSignal` on every page.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ThreadMessagesPage } from "../src/contract/core/threads";

describe("ThreadMessagesPage on the wire", () => {
  it("names the head signal, so a thread its answer started still opens", () => {
    const page = {
      messages: [],
      headSignal: { signalId: "S07", kind: "feedback", state: "answered", text: "signal S07", at: 7 },
    };
    const encoded = Schema.encodeUnknownSync(ThreadMessagesPage)(page, { onExcessProperty: "error" });
    expect(encoded).toEqual(page);
  });
});
