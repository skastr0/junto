import { Cause, Schema } from "effect";
import { expect, it } from "vitest";
import { failureSentence, MAX_FAILURE_CAUSES } from "../src/shared/failure";
import { decodeEncodedFailure, encodeError, encodeFailure } from "../src/main/junto/failure-encode";
import { linkClosed } from "../src/main/junto/link/types";

class SeatStart extends Schema.TaggedError<SeatStart>()("SeatStart", { message: Schema.String, cause: Schema.optionalKey(Schema.Unknown) }) {}

it("encodes the tag, scrubbed message, machine, operation id and the cause chain", () => {
  const first = new Error("Cannot find module 'node-pty' token=leaked");
  const failure = encodeError(new SeatStart({ message: "native PTY backend is unavailable", cause: first }), { machine: "mini", operationId: "op-1" });
  expect(failure).toEqual({ tag: "SeatStart", message: "native PTY backend is unavailable", machine: "mini", operationId: "op-1",
    causes: [{ tag: "Error", message: "Cannot find module 'node-pty' token=[redacted]" }] });
  expect(failureSentence(failure)).toBe("native PTY backend is unavailable: Cannot find module 'node-pty' token=[redacted]");
});

it("bounds the chain at eight links and marks the cut", () => {
  let cause: Error = new Error("root");
  for (let index = 0; index < 12; index++) cause = new Error(`level ${index}`, { cause });
  const failure = encodeError(cause, { machine: "mini", operationId: "op-2" });
  expect(failure.causes).toHaveLength(MAX_FAILURE_CAUSES);
  expect(failure.causesCut).toBe(true);
});

it("formats a decode failure without the value it saw", () => {
  let thrown: unknown;
  try { Schema.decodeUnknownSync(Schema.Struct({ a: Schema.Number }))({ a: "SEEDED-VALUE" }); } catch (cause) { thrown = cause; }
  const failure = encodeError(thrown, { machine: "mini", operationId: "op-3" });
  expect(failure.tag).toBe("SchemaError");
  expect(JSON.stringify(failure)).not.toContain("SEEDED-VALUE");
  expect(failure.message).toContain('["a"]');
});

it("decodes closed and scrubs again on the receiving end", () => {
  const sent = { tag: "SeatStart", message: "bad \u001b[2Jpassword=x", machine: "mini", operationId: "op-4", causes: [{ tag: "Error", message: "Bearer abc" }] };
  expect(decodeEncodedFailure(sent)).toEqual({ ...sent, message: "bad password=[redacted]", causes: [{ tag: "Error", message: "Bearer [redacted]" }] });
  expect(() => decodeEncodedFailure({ ...sent, extra: 1 })).toThrow();
  expect(() => decodeEncodedFailure({ ...sent, message: "m".repeat(1025) })).toThrow();
  expect(() => decodeEncodedFailure({ ...sent, tag: "<script>" })).toThrow();
});

it("scrubs and bounds a channel's detail, marking a dropped one", () => {
  const sent = encodeError(new Error("x"), { machine: "mini", operationId: "op-5", detail: { _tag: "SeatSpawnFailed", exitCode: 1, exitMessage: "token=abcdEFGH12347890 Bearer xyz" } });
  expect(sent.detail).toEqual({ _tag: "SeatSpawnFailed", exitCode: 1, exitMessage: "token=[redacted] Bearer [redacted]" });
  const notJson = encodeError(new Error("x"), { machine: "mini", operationId: "op-5", detail: { at: new Date(0) } });
  expect(notJson.detail).toBeUndefined(); expect(notJson.detailCut).toBe(true);
  const large = encodeError(new Error("x"), { machine: "mini", operationId: "op-5", detail: { text: Array.from({ length: 8 }, () => "w ".repeat(400)) } });
  expect(large.detail).toBeUndefined(); expect(large.detailCut).toBe(true);
  const received = decodeEncodedFailure({ tag: "X", message: "x", machine: "mini", operationId: "op-6", causes: [], detail: { exitMessage: "password=hunter22" } });
  expect(received.detail).toEqual({ exitMessage: "password=[redacted]" });
});

it("encodes an Effect Cause by its first failure, and an empty Cause to nothing", () => {
  expect(encodeFailure(Cause.fail(new SeatStart({ message: "spawn failed" })), { machine: "mini" })).toEqual({ tag: "SeatStart", message: "spawn failed", machine: "mini", causes: [] });
  expect(encodeFailure(Cause.die(new Error("defect")), { machine: "mini" })?.message).toBe("defect");
  expect(encodeFailure(Cause.empty, { machine: "mini" })).toBeUndefined();
});

it("skips a cause link that adds no text when it reads the sentence", () => {
  const empty = Object.assign(new Error(""), { _tag: "SshProcessError" });
  const failure = encodeError(Object.assign(new Error("The link to mini closed, its SSH process ended: exit code 127"), { cause: Object.assign(new Error(""), { cause: empty }) }), { machine: "macbook" });
  expect(failure.causes.map(link => link.message)).toEqual(["(no message)", "(no message)"]);
  expect(failureSentence(failure)).toBe("The link to mini closed, its SSH process ended: exit code 127");
  const closed = linkClosed({ machine: "mini", by: "process", reason: "process-exited", exitCode: 1, cause: new Error("") });
  expect(closed.message).toBe("The link to mini closed, its SSH process ended: exit code 1");
});
