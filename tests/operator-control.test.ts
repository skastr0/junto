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
    const valid = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "fleet.add",
      args: {
        id: "station-1",
        label: "Station 1",
        sshEndpoint: "junto@station-1",
        capabilities: ["terminal", "browser"],
      },
    });
    expect(Result.isSuccess(valid)).toBe(true);

    const extra = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "fleet.add",
      args: {
        id: "station-1",
        label: "Station 1",
        sshEndpoint: "junto@station-1",
        capabilities: ["terminal"],
        command: "sudo anything",
      },
    });
    expect(Result.isFailure(extra)).toBe(true);

    const unknown = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "fleet.shell",
      args: {},
    });
    expect(Result.isFailure(unknown)).toBe(true);
  });

  it("separates qualification from ordinary deployment sources", () => {
    const qualify = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-1",
      op: "fleet.qualify",
      args: { id: "station-1" },
    });
    expect(Result.isSuccess(qualify)).toBe(true);

    const qualifyWithSource = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-1",
      op: "fleet.qualify",
      args: { id: "station-1", source: "cached" },
    });
    expect(Result.isFailure(qualifyWithSource)).toBe(true);

    const deployWithoutSource = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "deploy-1",
      op: "fleet.deploy",
      args: { id: "station-1" },
    });
    expect(Result.isFailure(deployWithoutSource)).toBe(true);
  });

  it("rejects retired administrator-password authorization payloads", () => {
    const decoded = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-2",
      op: "fleet.qualify",
      args: {
        id: "station-1",
        authorization: {
          request: {
            kind: "linux-administrator-password",
            hostId: "station-1",
            endpoint: "junto@station-1",
            version: "0.1.5",
            manifestSha256: "a".repeat(64),
            debSha256: "b".repeat(64),
            inventorySha256: "c".repeat(64),
          },
          password: "one-shot-secret",
        },
      },
    });
    expect(Result.isFailure(decoded)).toBe(true);
    // V4 SchemaIssue trees retain `actual` for diagnostics; never
    // JSON.stringify the raw Result on a wire/log path. Product envelopes
    // must use a redacted formatter — assert rejection only here.
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("SchemaError");
    }
  });

  it("bounds encoded NDJSON requests", () => {
    expect(
      encodeOperatorFrame(
        {
          protocol: OPERATOR_PROTOCOL_VERSION,
          id: "status-1",
          op: "station.status",
          args: {},
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
