import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_MAX_REQUEST_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorRequest,
  encodeOperatorFrame,
  operatorControlSocketPath,
  redactOperatorRequestForLog,
} from "../src/shared/operator-control";

describe("operator control contract", () => {
  it("uses a dedicated owner-local socket without a token path", () => {
    expect(operatorControlSocketPath("/home/operator")).toBe(
      "/home/operator/.junto/operator/control.sock",
    );
  });

  it("strictly decodes the closed operation and argument union", () => {
    const deviceId = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
    const valid = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "companion.hello",
      args: { deviceId },
    });
    expect(Result.isSuccess(valid)).toBe(true);

    const extra = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "companion.hello",
      args: { deviceId, command: "sudo anything" },
    });
    expect(Result.isFailure(extra)).toBe(true);

    for (const op of ["companion.shell", "fleet.deploy", "qualification.work.prepare"]) {
      const unknown = decodeOperatorRequest({
        protocol: OPERATOR_PROTOCOL_VERSION,
        id: "request-1",
        op,
        args: {},
      });
      expect(Result.isFailure(unknown)).toBe(true);
    }
  });

  it("bounds encoded NDJSON requests", () => {
    expect(
      encodeOperatorFrame(
        {
          protocol: OPERATOR_PROTOCOL_VERSION,
          id: "hello-1",
          op: "companion.hello",
          args: { deviceId: "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3" },
        },
        OPERATOR_MAX_REQUEST_BYTES,
      ).endsWith("\n"),
    ).toBe(true);

    expect(() =>
      encodeOperatorFrame(
        { value: "x".repeat(OPERATOR_MAX_REQUEST_BYTES) },
        OPERATOR_MAX_REQUEST_BYTES,
      ),
    ).toThrow(/exceeds/);
  });
});
