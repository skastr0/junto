/**
 * A companion request's args are its op's, by the protocol's own request
 * schema: the session's own requests are held to them by the compiler
 * (companionRequest), and a relayed frame whose args are wrong or carry a key
 * the op does not name is refused where the core decodes it (the operator
 * request schema, decoded closed).
 */
import { Result } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COMPANION_PROTOCOL,
  companionRequest,
  decodeCompanionRequestLine,
  type CompanionOpName,
  type CompanionRequestFrame,
  type CompanionRequestOf,
} from "../src/shared/companion-protocol";
import { decodeOperatorRequest, OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import { NodeId } from "../src/shared/wire/ids";

const nodeId = NodeId.make("seat-a");
const relayed = (request: unknown) =>
  decodeOperatorRequest({
    protocol: OPERATOR_PROTOCOL_VERSION,
    id: "r1",
    op: "companion.call",
    args: { deviceId: "dev_01M65W89W7RMY723M451C6TKRJ", request },
  });
const frame = (args: unknown) => ({ v: COMPANION_PROTOCOL, type: "request", id: "q1", op: "mail.list", args });

describe("companion request args", () => {
  it("types each op's frame as the member the request schema decodes", () => {
    expectTypeOf<{ readonly [Op in CompanionOpName]: CompanionRequestOf<Op> }[CompanionOpName]>().toEqualTypeOf<CompanionRequestFrame>();
  });

  it("builds a frame whose args are its op's, and the compiler refuses any other", () => {
    expect(companionRequest("q1", "mail.list", { canvasName: "factory", nodeId, limit: 50 })).toEqual(
      frame({ canvasName: "factory", nodeId: "seat-a", limit: 50 }),
    );
    expect(companionRequest("q2", "canvases.list", {}).op).toBe("canvases.list");
    // @ts-expect-error a key mail.list does not name
    companionRequest("q3", "mail.list", { canvasName: "factory", nodeId, extra: true });
    // @ts-expect-error limit is a number
    companionRequest("q4", "mail.list", { canvasName: "factory", nodeId, limit: "50" });
    // @ts-expect-error nodeId is required
    companionRequest("q5", "seat.get", { canvasName: "factory" });
    // @ts-expect-error seats.list's args, not seat.get's
    companionRequest("q6", "seats.list", { canvasName: "factory", nodeId });
  });

  it("is decoded closed where the core receives it: a wrong or excess arg is refused", () => {
    expect(Result.isSuccess(relayed(frame({ canvasName: "factory", nodeId: "seat-a", limit: 50 })))).toBe(true);
    expect(Result.isFailure(relayed(frame({ canvasName: "factory", nodeId: "seat-a", extra: true })))).toBe(true);
    expect(Result.isFailure(relayed(frame({ canvasName: "factory", nodeId: "seat-a", limit: "50" })))).toBe(true);
    expect(Result.isFailure(relayed(frame({ canvasName: "factory" })))).toBe(true);
    expect(Result.isFailure(relayed({ ...frame({ canvasName: "factory", nodeId: "seat-a" }), op: "seats.list" }))).toBe(true);
  });

  it("refuses a wrong arg on the phone's line, and drops a key an open op does not name", () => {
    const line = (args: unknown) => JSON.stringify(frame(args));
    const wrong = decodeCompanionRequestLine(line({ canvasName: "factory", nodeId: "seat-a", limit: "50" }));
    expect(Result.isFailure(wrong) && wrong.failure.error.code).toBe("invalid");
    // mail.list's args are open on the phone's line (additive versioning,
    // docs/companion-protocol.md section 3): the key is dropped, never relayed.
    const extra = decodeCompanionRequestLine(line({ canvasName: "factory", nodeId: "seat-a", extra: true }));
    expect(Result.isSuccess(extra) && extra.success.args).toEqual({ canvasName: "factory", nodeId: "seat-a" });
  });
});
