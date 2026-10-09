import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { defaultRemoteHostsDocument, type RemoteHost } from "../src/shared/remote-hosts";
import { testHostConnection, runRemoteHostsDoctorSnapshot } from "../src/main/junto/hosts/doctor";
import type { HostsRegistry } from "../src/main/junto/hosts/registry";
import type { SshTransportShape } from "../src/main/junto/ssh/service";
import { SshExitError } from "../src/main/junto/ssh/domain";

const remote = { id: "mini", label: "Mini", isThisMachine: false, sshEndpoint: "mac-mini", capabilities: ["terminal"] } as RemoteHost;
const sshWith = (warm: SshTransportShape["warm"]) => ({ warm }) as SshTransportShape;

describe("machine reachability", () => {
  it("does not contact SSH for this machine", async () => {
    const warm = vi.fn();
    expect(await Effect.runPromise(testHostConnection(sshWith(warm), defaultRemoteHostsDocument("macbook").hosts[0]!)))
      .toMatchObject({ ok: true, reachability: "reachable" });
    expect(warm).not.toHaveBeenCalled();
  });

  it("reports SSH availability without inventing runtime readiness", async () => {
    const result = await Effect.runPromise(testHostConnection(sshWith(() => Effect.void), remote));
    expect(result).toEqual({ ok: true, detail: "SSH is available", reachability: "reachable" });
    expect(result).not.toHaveProperty("protocol");
  });

  it("reports a refused link while retaining other machines", async () => {
    const ssh = sshWith(() => Effect.fail(new SshExitError({ endpoint: "mac-mini", operation: "master-warm", code: 255, detail: "permission denied" })));
    const registry = { list: async () => [...defaultRemoteHostsDocument("macbook").hosts, remote] } as unknown as HostsRegistry;
    const snapshot = await Effect.runPromise(runRemoteHostsDoctorSnapshot(registry, ssh));
    expect(snapshot.check.status).toBe("warning");
    expect(snapshot.observations).toEqual([{ hostId: "mini", endpoint: "mac-mini", source: "live", reachability: "unreachable", reachabilityError: "permission denied" }]);
  });

  it("rejects malformed SSH endpoints before dialing", async () => {
    const warm = vi.fn();
    const result = await Effect.runPromise(testHostConnection(sshWith(warm), { ...remote, sshEndpoint: "-oProxyCommand=bad" }));
    expect(result.ok).toBe(false);
    expect(warm).not.toHaveBeenCalled();
  });
});
