import { Either } from "effect";
import { describe, expect, it } from "vitest";
import { observeLinuxHostCapabilityDoctor } from "../src/shared/linux-host-capability-doctor";
import {
  OPERATOR_MAX_REQUEST_BYTES,
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorRequest,
  decodeOperatorResponse,
  encodeOperatorFrame,
  operatorControlSocketPath,
  redactOperatorRequestForLog,
} from "../src/shared/operator-control";

const linuxCapabilities = () => {
  const values: ReadonlyArray<readonly [string, string]> = [
    ["probe_version", "1"],
    ["platform", "linux"],
    ["architecture", "x86_64"],
    ["os_id", "ubuntu"],
    ["os_version", "24.04"],
    ["glibc_version", "2.39"],
    ["home", "safe-writable"],
    ["home_exec", "ready"],
    ["disk_free_mib", "16384"],
    ["core_userland", "ready"],
    ["missing_binaries", "xvfb,xauth,mcookie"],
    ["runtime_libraries", "ready"],
    ["missing_libraries", "none"],
    ["user_systemd", "ready"],
    ["remote_service", "active"],
    ["linger", "disabled"],
    ["ptmx", "ready"],
    ["devpts", "ready"],
    ["native_pty", "ready"],
    ["xvfb", "missing"],
    ["xauth", "missing"],
    ["mcookie", "missing"],
    ["apparmor", "unavailable"],
    ["apparmor_profile", "not-required"],
    ["userns", "unavailable"],
    ["sandbox", "unavailable"],
    ["secret_storage", "unavailable"],
  ];
  const observation = observeLinuxHostCapabilityDoctor(
    `${values.map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
  if (observation === null) {
    throw new Error("invalid Linux capability fixture");
  }
  return observation;
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

  it("preserves the exact Linux capability observation on fleet.test", () => {
    const observation = linuxCapabilities();
    const decoded = decodeOperatorResponse({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "test-linux",
      ok: true,
      op: "fleet.test",
      data: {
        hostId: "station-1",
        ok: true,
        detail: "Station reachable · core ready",
        reachability: "reachable",
        linuxCapabilities: observation,
      },
    });
    if (Either.isLeft(decoded)) {
      throw new Error("fleet.test Linux observation did not decode");
    }
    expect(decoded.right).toMatchObject({
      ok: true,
      op: "fleet.test",
      data: {
        linuxCapabilities: observation,
      },
    });

    const malformed = decodeOperatorResponse({
      protocol: OPERATOR_PROTOCOL_VERSION,
      id: "test-linux-malformed",
      ok: true,
      op: "fleet.test",
      data: {
        hostId: "station-1",
        ok: true,
        detail: "Station reachable · core ready",
        linuxCapabilities: {
          ...observation,
          browser: {
            ...observation.browser,
            hiddenSudoPath: "/usr/bin/sudo",
          },
        },
      },
    });
    expect(Either.isLeft(malformed)).toBe(true);
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
            endpoint: "vellum@station-1",
            version: "0.1.5",
            manifestSha256: "a".repeat(64),
            debSha256: "b".repeat(64),
            inventorySha256: "c".repeat(64),
          },
          password: "one-shot-secret",
        },
      },
    });
    expect(Either.isLeft(decoded)).toBe(true);
    expect(JSON.stringify(decoded)).not.toContain("one-shot-secret");
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
