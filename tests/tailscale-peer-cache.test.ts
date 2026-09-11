import { afterEach, describe, expect, it, vi } from "vitest";
import { TailscalePeerCache } from "../src/main/vellum-command/hosts/tailscale-peers";

const statusJson = JSON.stringify({
  Self: {
    HostName: "laptop",
    DNSName: "laptop.example.ts.net.",
    TailscaleIPs: ["100.64.0.10"],
    Online: true,
  },
  Peer: {
    k1: {
      HostName: "Developer desktop",
      DNSName: "remote-a.example.ts.net.",
      TailscaleIPs: ["100.64.0.20"],
      Online: true,
    },
  },
});

describe("TailscalePeerCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves host after refresh using injected status runner", async () => {
    const runStatus = vi.fn(async () => ({ ok: true, stdout: statusJson }));
    const cache = new TailscalePeerCache({
      runStatus,
      ttlMs: 60_000,
      now: () => 1_000,
    });

    // Cold: kicks refresh, no snapshot yet on first sync resolve
    await cache.refresh();
    expect(runStatus).toHaveBeenCalled();

    // findHostById may not know remote-a in tests — still matches on hostId alone
    const host = cache.resolveHost("remote-a");
    expect(host).toBe("remote-a.example.ts.net");
  });

  it("serves cache within TTL without re-running CLI", async () => {
    let now = 0;
    const runStatus = vi.fn(async () => ({ ok: true, stdout: statusJson }));
    const cache = new TailscalePeerCache({
      runStatus,
      ttlMs: 10_000,
      now: () => now,
    });
    now = 100;
    await cache.refresh();
    expect(runStatus).toHaveBeenCalledTimes(1);
    now = 5_000;
    expect(cache.resolveHost("remote-a")).toBe("remote-a.example.ts.net");
    expect(runStatus).toHaveBeenCalledTimes(1);
  });

  it("soft-fails when tailscale CLI missing", async () => {
    const cache = new TailscalePeerCache({
      runStatus: async () => ({ ok: false, stdout: "", error: "not found" }),
      now: () => 1,
    });
    await cache.refresh();
    expect(cache.resolveHost("remote-a")).toBeUndefined();
  });
});
