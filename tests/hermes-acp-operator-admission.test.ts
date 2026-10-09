import type { AppProcessLease } from "../src/main/junto/app-process-plane";
import { bindLocalAcpProcessIdentity } from "../src/main/junto/hermes/plane";
import {
  makeProcessIdentityMap,
  type ProcessIdentityMap,
} from "../src/main/junto/process-identity";
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
  it("binds the local ACP generation to its agent key", () => {
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

    expect(processMap.resolve(320)).toEqual({ agentKey: "local:default" });
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
