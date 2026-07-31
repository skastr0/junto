import type { AppProcessLease } from "../src/main/vellum/app-process-plane";
import { bindLocalAcpProcessIdentity } from "../src/main/vellum/hermes/plane";
import { admitOperatorPeer } from "../src/main/vellum/operator-control/admission";
import {
  makeProcessIdentityMap,
  type ProcessIdentityMap,
} from "../src/main/vellum/process-identity";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

const leaseWith = (
  pid: number | undefined,
  onClose: (listener: () => void) => () => void = () => () => undefined,
): AppProcessLease =>
  ({
    io: {
      pidForDiagnostics: pid,
      onClose,
    },
  }) as unknown as AppProcessLease;

describe("attached ACP operator isolation", () => {
  it("binds the local ACP generation so its descendants are denied", () => {
    const processMap = makeProcessIdentityMap({
      processAlive: () => true,
      readProcessStartKey: () => "acp-epoch",
    });
    bindLocalAcpProcessIdentity(
      leaseWith(320),
      "local:default",
      { terminate: vi.fn() },
      processMap,
    );

    const parents = new Map([
      [410, 320],
      [320, 20],
      [20, 1],
    ]);
    expect(
      admitOperatorPeer({} as Socket, {
        processMap,
        readPeerPid: () => 410,
        readParentPid: (pid) => parents.get(pid),
      }),
    ).toEqual({ ok: false, reason: "registered-process-tree" });
  });

  it.each([undefined, 320])(
    "terminates and rejects a local ACP when identity bind fails (pid=%s)",
    (pid) => {
      const terminate = vi.fn();
      const processMap = {
        bindGeneration: () => undefined,
      } as unknown as ProcessIdentityMap;

      expect(() =>
        bindLocalAcpProcessIdentity(
          leaseWith(pid),
          "local:default",
          { terminate },
          processMap,
        ),
      ).toThrow("local ACP process identity admission failed");
      expect(terminate).toHaveBeenCalledOnce();
    },
  );
});
