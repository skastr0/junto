import { describe, expect, it, vi } from "vitest";
import { HostServeCatalog } from "../src/main/vellum/hosts/serve-catalog";
import { HerdrServiceMap } from "../src/main/vellum/herdr/service-map";

const miniServeJson = JSON.stringify({
  TCP: {
    "8090": { TCPForward: "127.0.0.1:5175" },
  },
  Services: {
    "svc:booth-control": {
      Web: {
        "booth-control.example.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:5175" },
          },
        },
      },
    },
  },
});

describe("HostServeCatalog", () => {
  it("parses serve status and joins local ports to SVC URL", async () => {
    const catalog = new HostServeCatalog({
      runServeStatus: async () => ({ ok: true, stdout: miniServeJson }),
      resolveHostBase: () => "remote-a.example.ts.net",
      now: () => 1_000,
    });
    const cat = await catalog.refresh("remote-a");
    expect(cat.entries.some((e) => e.kind === "svc")).toBe(true);
    const hit = catalog.preferredUrl("remote-a", [5175]);
    expect(hit?.url).toBe("https://booth-control.example.ts.net");
  });

  it("keeps prior entries when refresh fails", async () => {
    let n = 0;
    const catalog = new HostServeCatalog({
      runServeStatus: async () => {
        n += 1;
        if (n === 1) return { ok: true, stdout: miniServeJson };
        return { ok: false, stdout: "", error: "ssh down" };
      },
      now: () => 1_000,
    });
    await catalog.refresh("remote-a");
    const after = await catalog.refresh("remote-a");
    expect(after.entries.length).toBeGreaterThan(0);
    expect(after.error).toMatch(/ssh down/);
    expect(catalog.preferredUrl("remote-a", [5175])?.url).toContain("booth-control");
  });

  it("cuts late refresh admission and retains the exact admitted refresh", async () => {
    vi.useFakeTimers();
    let release!: (result: { ok: true; stdout: string }) => void;
    const result = new Promise<{ ok: true; stdout: string }>((resolve) => {
      release = resolve;
    });
    const runServeStatus = vi.fn(() => result);
    const catalog = new HostServeCatalog({
      runServeStatus,
      shutdownDrainTimeoutMs: 25,
      now: () => 1,
    });
    try {
      const admitted = catalog.refresh("remote-a");
      catalog.beginShutdown();
      await expect(catalog.refresh("late")).resolves.toMatchObject({
        hostId: "late",
        error: "Herdr Serve catalog is shutting down",
      });
      expect(runServeStatus).toHaveBeenCalledOnce();

      const first = catalog.drainOnQuit();
      expect(catalog.drainOnQuit()).toBe(first);
      await vi.advanceTimersByTimeAsync(25);
      await expect(first).resolves.toMatchObject({ clean: false, retained: 1 });

      release({ ok: true, stdout: miniServeJson });
      await admitted;
      await expect(catalog.drainOnQuit()).resolves.toMatchObject({ clean: true, retained: 0 });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("HostServiceMap × Serve join", () => {
  it("prefers SVC public URL over host:port compose", async () => {
    const catalog = new HostServeCatalog({
      runServeStatus: async () => ({ ok: true, stdout: miniServeJson }),
      resolveHostBase: () => "remote-a.example.ts.net",
      now: () => 1,
    });
    await catalog.refresh("remote-a");

    const map = new HerdrServiceMap({
      shell: async () => ({
        ok: true,
        stdout: "node 42 me 1u IPv4 0t0 TCP *:5175 (LISTEN)\n",
      }),
      resolveTailscaleHost: () => "remote-a.example.ts.net",
      resolvePreferredServeUrl: (hostId, ports) => {
        const hit = catalog.preferredUrl(hostId, ports);
        return hit ? { url: hit.url, label: hit.entry.label } : undefined;
      },
      now: () => 1,
    });

    map.requestProbe({
      hostId: "remote-a",
      paneId: "w:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 42 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    const live = map.get("remote-a", null, "w:p1");
    expect(live?.url).toBe("https://booth-control.example.ts.net");
    expect(live?.serveJoined).toBe(true);
    expect(live?.serveLabel).toBe("booth-control");
    map.stop();
  });

  it("transport fail keeps serveJoined SVC url", async () => {
    let n = 0;
    const catalog = new HostServeCatalog({
      runServeStatus: async () => ({ ok: true, stdout: miniServeJson }),
      resolveHostBase: () => "remote-a.example.ts.net",
      now: () => 1,
    });
    await catalog.refresh("remote-a");
    const map = new HerdrServiceMap({
      shell: async () => {
        n += 1;
        if (n === 1) {
          return { ok: true, stdout: "node 42 me 1u IPv4 0t0 TCP *:5175 (LISTEN)\n" };
        }
        return { ok: false, stdout: "", error: "ssh timed out" };
      },
      resolvePreferredServeUrl: (hostId, ports) => {
        const hit = catalog.preferredUrl(hostId, ports);
        return hit ? { url: hit.url, label: hit.entry.label } : undefined;
      },
      now: () => 1,
    });
    map.requestProbe({
      hostId: "remote-a",
      paneId: "w:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 42 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    expect(map.get("remote-a", null, "w:p1")?.serveJoined).toBe(true);

    map.requestProbe({
      hostId: "remote-a",
      paneId: "w:p1",
      processes: [{ name: "node", cmdline: "vite", pid: 42 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    const after = map.get("remote-a", null, "w:p1");
    expect(after?.url).toBe("https://booth-control.example.ts.net");
    expect(after?.serveJoined).toBe(true);
    expect(after?.error).toMatch(/timed out/);
    map.stop();
  });
});
