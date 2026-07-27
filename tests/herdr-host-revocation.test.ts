import { afterEach, describe, expect, it } from "vitest";
import { defaultRemoteHostsDocument, type RemoteHost } from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";
import {
  HerdrMirrorRegistry,
  type HerdrHostRevocationHooks,
} from "../src/main/vellum/herdr/mirrors";
import type { MirrorTransport } from "../src/main/vellum/herdr/mirror-transport";

/**
 * Choke-point tests: host removal/edit must synchronously revoke every live
 * herdr resource for the affected host — detach control streams, drop pooled
 * observers, and tear down the shared ssh ControlMaster — while an untouched
 * host's resources survive reconciliation untouched. The mirror transport
 * itself is faked here (its own rebuild-on-any-change behavior is covered by
 * tests/remote-hosts-registry.test.ts); this file exercises the NEW
 * revocation hooks HerdrMirrorRegistry drives during reconcileHosts.
 */

afterEach(() => {
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
});

const fakeTransport = (): MirrorTransport => ({
  request: async () => ({ snapshot: {} }),
  openEvents: async () => () => undefined,
  dispose: () => undefined,
});

const remoteHost = (id: string, endpoint: string): RemoteHost => ({
  id,
  label: id,
  kind: "remote",
  sshEndpoint: endpoint,
  capabilities: ["herdr"],
});

const recordingHooks = (): { readonly calls: string[]; readonly hooks: HerdrHostRevocationHooks } => {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      detachByHost: (hostId) => calls.push(`detach:${hostId}`),
      releaseByHost: (hostId) => calls.push(`release:${hostId}`),
      teardownEndpoint: (endpoint) => calls.push(`teardown:${endpoint}`),
    },
  };
};

describe("herdr host revocation at the reconciliation choke point", () => {
  it("removal calls detach, release, and ssh teardown in order for the removed host", () => {
    setHostsSnapshot([...defaultRemoteHostsDocument().hosts, remoteHost("studio", "studio-a")]);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      setHostsSnapshot(defaultRemoteHostsDocument().hosts); // removes "studio"

      expect(calls).toEqual(["detach:studio", "release:studio", "teardown:studio-a"]);
    } finally {
      mirrors.stopAll();
    }
  });

  it("endpoint edit is remove+add: tears down the OLD endpoint, none for the new one", () => {
    const withStudio = [...defaultRemoteHostsDocument().hosts, remoteHost("studio", "studio-a")];
    setHostsSnapshot(withStudio);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      setHostsSnapshot(
        withStudio.map((host) => (host.id === "studio" ? { ...host, sshEndpoint: "studio-b" } : host)),
      );

      expect(calls).toEqual(["detach:studio", "release:studio", "teardown:studio-a"]);
    } finally {
      mirrors.stopAll();
    }
  });

  it("losing herdr capability on a same-id edit revokes like a removal", () => {
    const withStudio = [...defaultRemoteHostsDocument().hosts, remoteHost("studio", "studio-a")];
    setHostsSnapshot(withStudio);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      setHostsSnapshot(
        withStudio.map((host) =>
          host.id === "studio" ? { ...host, capabilities: ["hermes" as const] } : host,
        ),
      );

      expect(calls).toEqual(["detach:studio", "release:studio", "teardown:studio-a"]);
    } finally {
      mirrors.stopAll();
    }
  });

  it("an untouched host's resources survive reconciliation", () => {
    const withTwo = [
      ...defaultRemoteHostsDocument().hosts,
      remoteHost("studio", "studio-a"),
      remoteHost("render", "render-a"),
    ];
    setHostsSnapshot(withTwo);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      // Only "studio" is removed; "render" and "local" are untouched.
      setHostsSnapshot(withTwo.filter((host) => host.id !== "studio"));

      expect(calls).toEqual(["detach:studio", "release:studio", "teardown:studio-a"]);
      expect(calls.some((c) => c.includes("render") || c.includes("local"))).toBe(false);
    } finally {
      mirrors.stopAll();
    }
  });

  it("reconciliation with no changes calls nothing", () => {
    const withStudio = [...defaultRemoteHostsDocument().hosts, remoteHost("studio", "studio-a")];
    setHostsSnapshot(withStudio);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      // Structurally-identical re-snapshot: setHostsSnapshot no-ops on a
      // deep-equal document, so the reconciliation listener never fires.
      setHostsSnapshot(withStudio.map((host) => ({ ...host })));

      expect(calls).toEqual([]);
    } finally {
      mirrors.stopAll();
    }
  });

  it("adding a new host revokes nothing — there is no prior state for it", () => {
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    const { calls, hooks } = recordingHooks();
    const mirrors = new HerdrMirrorRegistry(fakeTransport, hooks);
    try {
      mirrors.startAll();
      calls.length = 0;

      setHostsSnapshot([...defaultRemoteHostsDocument().hosts, remoteHost("studio", "studio-a")]);

      expect(calls).toEqual([]);
    } finally {
      mirrors.stopAll();
    }
  });

  it("permanently cuts mirror admission and returns an idempotent clean receipt", async () => {
    const mirrors = new HerdrMirrorRegistry(fakeTransport);
    mirrors.startAll();
    expect(mirrors.mirrorFor("local")).toBeDefined();

    const first = await mirrors.drainOnQuit();
    expect(first).toMatchObject({ clean: true, retained: 0 });
    expect(mirrors.mirrorFor("local")).toBeUndefined();
    mirrors.startAll();
    expect(mirrors.mirrorFor("local")).toBeUndefined();
    await expect(mirrors.drainOnQuit()).resolves.toBe(first);
  });
});
