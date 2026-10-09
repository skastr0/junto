import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import { makeBrowserProfileService } from "../src/main/junto/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
} from "../src/main/junto/browser/sessions";
import { prepareBrowserHostCapabilityAuthority } from "../src/main/junto/browser/station-authority";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

const studio: RemoteHost = {
  id: "studio",
  label: "studio",
  isThisMachine: true,
  capabilities: ["browser"],
};
const atlas: RemoteHost = {
  id: "atlas",
  label: "atlas",
  isThisMachine: false,
  sshEndpoint: "atlas",
  capabilities: ["browser"],
};

const target = (nodeId: string, hostId: string): ResolvedPageTarget => ({
  ref: `junto://canvas/work?node=${nodeId}`,
  nodeId,
  hostId,
  url: `https://${nodeId}.example.com`,
  profile: "personal",
});

describe("browser machine authority", () => {
  const roots: string[] = [];
  const stateRuntimes: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, unknown>[] = [];

  const makeProfiles = async (root: string) => {
    const runtime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "junto.db")),
    );
    const sql = await runtime.runPromise(SqlClient.SqlClient);
    stateRuntimes.push(runtime);
    return makeBrowserProfileService(sql, root);
  };

  afterEach(async () => {
    for (const runtime of stateRuntimes.splice(0)) await runtime.dispose();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const makeAdapter = () => {
    const calls = { count: 0 };
    const adapter: BrowserViewAdapter = () => {
      calls.count += 1;
      return {
        loadUrl: async () => {},
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
      };
    };
    return { adapter, calls };
  };

  it("names this machine from the list's own row and refuses another machine's page", async () => {
    const list = [studio, atlas];
    const lease = await prepareBrowserHostCapabilityAuthority({
      findHost: (hostId) => list.find((host) => host.id === hostId),
      hosts: () => list,
    });
    const root = await mkdtemp(join(tmpdir(), "junto-browser-machine-"));
    roots.push(root);
    const { adapter, calls } = makeAdapter();
    let sessionId = 0;
    const service = new BrowserSessionService(
      adapter,
      lease.authority,
      await makeProfiles(root),
      Date.now,
      () => `session-${++sessionId}`,
    );

    expect(lease.authority.machineName()).toBe("studio");
    expect(await service.open(target("on-atlas", "atlas"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(calls.count).toBe(0);
    expect((await service.open(target("here", "studio"))).ok).toBe(true);
    expect(calls.count).toBe(1);
    lease.close();
  });

  it("fails closed before the list has hydrated and follows it once it has", async () => {
    let list: ReadonlyArray<RemoteHost> = [];
    const lease = await prepareBrowserHostCapabilityAuthority({
      findHost: (hostId) => list.find((host) => host.id === hostId),
      hosts: () => list,
    });
    const root = await mkdtemp(join(tmpdir(), "junto-browser-machine-"));
    roots.push(root);
    const { adapter, calls } = makeAdapter();
    let sessionId = 0;
    const service = new BrowserSessionService(
      adapter,
      lease.authority,
      await makeProfiles(root),
      Date.now,
      () => `session-${++sessionId}`,
    );

    expect(lease.authority.machineName()).toBeUndefined();
    expect(await service.open(target("early", "studio"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(calls.count).toBe(0);

    list = [studio, atlas];
    expect(lease.authority.machineName()).toBe("studio");
    expect((await service.open(target("hydrated", "studio"))).ok).toBe(true);
    expect(calls.count).toBe(1);
    lease.close();
  });
});
