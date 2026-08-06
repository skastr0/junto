import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Effect, ManagedRuntime } from "effect";
import { defaultSettings, type Settings } from "../src/shared/settings";
import type { RemoteHost } from "../src/shared/remote-hosts";
import type { ResolvedPageTarget } from "../src/main/vellum/browser/page-target";
import { makeBrowserProfileService } from "../src/main/vellum/browser/profiles";
import {
  BrowserSessionService,
  type BrowserViewAdapter,
} from "../src/main/vellum/browser/sessions";
import { prepareBrowserHostCapabilityAuthority } from "../src/main/vellum/browser/station-authority";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum/state/engine";

const hosts: ReadonlyArray<RemoteHost> = [
  {
    id: "local",
    label: "local",
    kind: "local",
    capabilities: ["browser"],
  },
  {
    id: "studio",
    label: "studio",
    kind: "remote",
    sshEndpoint: "studio",
    capabilities: ["browser"],
  },
];

const target = (nodeId: string, hostId: string): ResolvedPageTarget => ({
  ref: `vellum://canvas/work?node=${nodeId}`,
  nodeId,
  hostId,
  url: `https://${nodeId}.example.com`,
  profile: "personal",
});

const settingsAt = (
  role: Settings["station"]["role"],
  hostId: string,
): Settings => ({
  ...defaultSettings(),
  station: {
    ...defaultSettings().station,
    role,
    hostId,
  },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("browser physical-station authority", () => {
  const roots: string[] = [];
  const stateRuntimes: ManagedRuntime.ManagedRuntime<StateEngine, unknown>[] = [];

  const makeProfiles = async (root: string) => {
    const runtime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    const state: Context.Service.Shape<typeof StateEngine> =
      await runtime.runPromise(StateEngine);
    stateRuntimes.push(runtime);
    return makeBrowserProfileService(state, root);
  };

  afterEach(async () => {
    for (const runtime of stateRuntimes.splice(0)) await runtime.dispose();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("awaits durable Remote identity and never creates a local view during boot", async () => {
    const loading = deferred<Settings>();
    let listener: ((settings: Settings) => void) | undefined;
    const preparing = prepareBrowserHostCapabilityAuthority(
      {
        get: Effect.promise(() => loading.promise),
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      (hostId) => hosts.find((host) => host.id === hostId),
    );
    let ready = false;
    void preparing.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    expect(listener).toBeDefined();
    // The subscribed transaction wins even if the older boot read resolves
    // afterward; there is no stale read/subscribe window.
    listener?.(settingsAt("remote", "studio"));
    loading.resolve(settingsAt("command-center", "local"));
    const lease = await preparing;
    const root = await mkdtemp(join(tmpdir(), "vellum-command-browser-station-"));
    roots.push(root);
    let adapterCalls = 0;
    const adapter: BrowserViewAdapter = () => {
      adapterCalls += 1;
      return {
        loadUrl: async () => {},
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
      };
    };
    const service = new BrowserSessionService(
      adapter,
      lease.authority,
      await makeProfiles(root),
      Date.now,
      () => "session-remote",
    );

    expect(await service.open(target("legacy-local", "local"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(adapterCalls).toBe(0);
    expect(lease.authority.station()).toEqual({
      hostId: "studio",
      role: "remote",
    });
    lease.close();
  });

  it("switches authority in the same accepted Settings transaction", async () => {
    let listener: ((settings: Settings) => void) | undefined;
    const lease = await prepareBrowserHostCapabilityAuthority(
      {
        get: Effect.succeed(settingsAt("command-center", "local")),
        subscribe: (next) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      },
      (hostId) => hosts.find((host) => host.id === hostId),
    );
    const root = await mkdtemp(join(tmpdir(), "vellum-command-browser-station-"));
    roots.push(root);
    let adapterCalls = 0;
    const adapter: BrowserViewAdapter = () => {
      adapterCalls += 1;
      return {
        loadUrl: async () => {},
        attach: () => {},
        setBounds: () => {},
        detach: () => {},
        destroy: () => {},
      };
    };
    let sessionId = 0;
    const service = new BrowserSessionService(
      adapter,
      lease.authority,
      await makeProfiles(root),
      Date.now,
      () => `session-${++sessionId}`,
    );

    expect((await service.open(target("before-change", "local"))).ok).toBe(true);
    expect(adapterCalls).toBe(1);

    listener?.(settingsAt("remote", "studio"));
    expect(await service.open(target("stale-local", "local"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
    expect(adapterCalls).toBe(1);

    expect((await service.open(target("after-change", "studio"))).ok).toBe(true);
    expect(adapterCalls).toBe(2);
    lease.close();
    expect(listener).toBeUndefined();
  });
});
