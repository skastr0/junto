import { Either } from "effect";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_MAX_REQUEST_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorRequest,
  encodeOperatorFrame,
  operatorControlSocketPath,
  redactOperatorRequestForLog,
} from "../src/shared/operator-control";

const authorizationRequest = {
  kind: "linux-administrator-password" as const,
  hostId: "station-1",
  endpoint: "vellum@station-1",
  version: "0.1.5",
  manifestSha256: "a".repeat(64),
  debSha256: "b".repeat(64),
  inventorySha256: "c".repeat(64),
};

describe("operator control contract", () => {
  it("uses a dedicated owner-local socket without a token path", () => {
    expect(operatorControlSocketPath("/home/operator")).toBe(
      "/home/operator/.vellum/operator/control.sock",
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
        sshEndpoint: "vellum@station-1",
        capabilities: ["terminal", "browser"],
      },
    });
    expect(Either.isRight(valid)).toBe(true);

    const extra = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "fleet.add",
      args: {
        id: "station-1",
        label: "Station 1",
        sshEndpoint: "vellum@station-1",
        capabilities: ["terminal"],
        command: "sudo anything",
      },
    });
    expect(Either.isLeft(extra)).toBe(true);

    const unknown = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "request-1",
      op: "fleet.shell",
      args: {},
    });
    expect(Either.isLeft(unknown)).toBe(true);
  });

  it("separates qualification from ordinary deployment sources", () => {
    const qualify = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-1",
      op: "fleet.qualify",
      args: { id: "station-1" },
    });
    expect(Either.isRight(qualify)).toBe(true);

    const qualifyWithSource = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-1",
      op: "fleet.qualify",
      args: { id: "station-1", source: "cached" },
    });
    expect(Either.isLeft(qualifyWithSource)).toBe(true);

    const deployWithoutSource = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "deploy-1",
      op: "fleet.deploy",
      args: { id: "station-1" },
    });
    expect(Either.isLeft(deployWithoutSource)).toBe(true);
  });

  it("binds and redacts the one-shot administrator retry", () => {
    const decoded = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-2",
      op: "fleet.qualify",
      args: {
        id: "station-1",
        authorization: {
          request: authorizationRequest,
          password: "one-shot-secret",
        },
      },
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isLeft(decoded)) return;

    expect(
      JSON.stringify(redactOperatorRequestForLog(decoded.right)),
    ).not.toContain("one-shot-secret");

    const multiline = decodeOperatorRequest({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "qualify-3",
      op: "fleet.qualify",
      args: {
        id: "station-1",
        authorization: {
          request: authorizationRequest,
          password: "line-one\nline-two",
        },
      },
    });
    expect(Either.isLeft(multiline)).toBe(true);
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
