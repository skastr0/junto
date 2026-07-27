/**
 * Integration-style tests: service map + Tailscale host base + lsof + queue.
 * No live herdr/SSH — inject shell + resolveTailscaleHost.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrServiceMap } from "../src/main/vellum/herdr/service-map";
import { TailscalePeerCache } from "../src/main/vellum/hosts/tailscale-peers";
import {
  parseTailscaleStatusJson,
  resolveTailscaleHostForQuery,
} from "../src/shared/tailscale-peers";

const tsStatus = {
  Peer: {
    k: {
      HostName: "Mac mini",
      DNSName: "remote-a.example.ts.net.",
      TailscaleIPs: ["100.64.0.20"],
      Online: true,
    },
  },
};

describe("HostServiceMap × Tailscale integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("remote pane composes MagicDNS URL when Tailscale peer resolves", async () => {
    const status = parseTailscaleStatusJson(tsStatus);
    const tsHost = resolveTailscaleHostForQuery(
      { hostId: "remote-a", sshEndpoint: "remote-a" },
      status,
    );
    expect(tsHost).toBe("remote-a.example.ts.net");

    const shell = async () => ({
      ok: true,
      stdout: "node 99 me 1u IPv4 0t0 TCP *:3000 (LISTEN)\n",
    });
    const map = new HerdrServiceMap({
      shell,
      resolveTailscaleHost: (id) =>
        id === "remote-a" ? tsHost : undefined,
      now: () => 50_000,
    });

    map.requestProbe({
      hostId: "remote-a",
      paneId: "w1:p1",
      processes: [{ name: "node", cmdline: "next dev", pid: 99 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    const live = map.get("remote-a", null, "w1:p1");
    expect(live?.health).toBe("live");
    expect(live?.url).toBe("http://remote-a.example.ts.net:3000");
    map.stop();
  });

  it("falls back to endpoint hostname when Tailscale unavailable", async () => {
    const map = new HerdrServiceMap({
      shell: async () => ({
        ok: true,
        stdout: "node 1 me 1u IPv4 0t0 TCP *:5173 (LISTEN)\n",
      }),
      resolveTailscaleHost: () => undefined,
      now: () => 1,
    });
    map.requestProbe({
      hostId: "remote-a",
      paneId: "p1",
      processes: [{ name: "node", cmdline: "vite", pid: 1 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    // hostId used as endpoint fallback when registry missing + no Tailscale
    expect(map.get("remote-a", null, "p1")?.url).toBe("http://remote-a:5173");
    map.stop();
  });

  it("TailscalePeerCache + service map compose end-to-end", async () => {
    const cache = new TailscalePeerCache({
      runStatus: async () => ({ ok: true, stdout: JSON.stringify(tsStatus) }),
      ttlMs: 60_000,
      now: () => 1,
    });
    await cache.refresh();

    const map = new HerdrServiceMap({
      shell: async () => ({
        ok: true,
        stdout: "node 7 me 1u IPv4 0t0 TCP *:8080 (LISTEN)\n",
      }),
      resolveTailscaleHost: (id) => cache.resolveHost(id),
      now: () => 1,
    });
    map.requestProbe({
      hostId: "remote-a",
      paneId: "p9",
      processes: [{ name: "node", cmdline: "http-server", pid: 7 }],
      priority: "intent",
    });
    await map.drainHostNow("remote-a");
    expect(map.get("remote-a", null, "p9")?.url).toBe(
      "http://remote-a.example.ts.net:8080",
    );
    map.stop();
  });

  it("ambient TTL re-enqueues live servers without intent", async () => {
    let shellCalls = 0;
    const shell = async () => {
      shellCalls += 1;
      return {
        ok: true,
        stdout: "node 3 me 1u IPv4 0t0 TCP *:4000 (LISTEN)\n",
      };
    };
    const map = new HerdrServiceMap({
      shell,
      ambientTtlMs: 30,
      tickIntervalMs: 10_000,
      now: () => Date.now(),
      resolveTailscaleHost: () => undefined,
    });
    map.requestProbe({
      hostId: "local",
      paneId: "p1",
      processes: [{ name: "node", cmdline: "vite", pid: 3 }],
      priority: "intent",
    });
    await map.drainHostNow("local");
    expect(shellCalls).toBe(1);
    expect(map.get("local", null, "p1")?.health).toBe("live");

    await new Promise((r) => setTimeout(r, 50));
    // Ambient timer enqueued work; drain explicitly (tick would fire later).
    await map.drainHostNow("local");
    expect(shellCalls).toBeGreaterThanOrEqual(2);
    map.stop();
  });
});

