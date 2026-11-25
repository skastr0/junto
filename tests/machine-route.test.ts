import { describe, expect, it } from "vitest";
import { machineRouteFingerprint } from "../src/core/hosts/machine-route";
import type { RemoteHost } from "../src/shared/remote-hosts";

const host = (): RemoteHost => ({
  id: "mini", label: "Mini", isThisMachine: false, sshEndpoint: "mac-mini", sshPort: 22,
  sshIdentityFile: "/home/me/.ssh/id_ed25519", sshKnownHostsFile: "/home/me/.ssh/known_hosts", sshHostKeyAlias: "mini-key",
  juntoHome: "/home/probe", installRoot: "/home/probe/install", capabilities: ["terminal"],
});

describe("machine route fingerprint", () => {
  it("changes with every route field and with nothing presentation carries", () => {
    const base = machineRouteFingerprint(host());
    for (const change of [
      { sshEndpoint: "other-mini" }, { sshPort: 2222 }, { sshIdentityFile: "/home/me/.ssh/other" },
      { sshKnownHostsFile: "/home/me/.ssh/other_known_hosts" }, { sshHostKeyAlias: "other-key" },
      { juntoHome: "/home/other" }, { installRoot: "/home/other/install" },
    ] satisfies ReadonlyArray<Partial<RemoteHost>>) {
      expect(machineRouteFingerprint({ ...host(), ...change })).not.toBe(base);
    }
    expect(machineRouteFingerprint({ ...host(), label: "Another label", capabilities: ["terminal"] })).toBe(base);
  });
});
