import { describe, expect, it } from "vitest";
import {
  endpointHostToken,
  matchTailscalePeer,
  parseTailscaleStatusJson,
  peerReachableHost,
  resolveTailscaleHostForQuery,
} from "../src/shared/tailscale-peers";

/** Synthetic peers with the `tailscale status --json` shape and address ranges. */
const fixtureStatus = {
  Self: {
    HostName: "Developer laptop",
    DNSName: "laptop.example.ts.net.",
    TailscaleIPs: ["100.64.0.10", "fd7a:115c:a1e0::10"],
    Online: true,
  },
  Peer: {
    nodekey1: {
      HostName: "Developer desktop",
      DNSName: "remote-a.example.ts.net.",
      TailscaleIPs: ["100.64.0.20", "fd7a:115c:a1e0::20"],
      Online: true,
    },
    nodekey2: {
      HostName: "phone",
      DNSName: "phone.example.ts.net.",
      TailscaleIPs: ["100.64.0.30"],
      Online: true,
    },
    nodekey3: {
      HostName: "old-box",
      DNSName: "stale-box.example.ts.net.",
      TailscaleIPs: ["100.64.0.40"],
      Online: false,
    },
  },
};

describe("tailscale-peers parse", () => {
  it("parses Self + Peer map", () => {
    const snap = parseTailscaleStatusJson(fixtureStatus);
    expect(snap.self?.ipv4).toBe("100.64.0.10");
    expect(snap.peers).toHaveLength(3);
    expect(snap.peers.find((p) => p.dnsName?.includes("remote-a"))?.ipv4).toBe(
      "100.64.0.20",
    );
  });

  it("prefers MagicDNS without trailing dot", () => {
    const peer = parseTailscaleStatusJson(fixtureStatus).peers.find((p) =>
      p.dnsName?.includes("remote-a"),
    )!;
    expect(peerReachableHost(peer)).toBe("remote-a.example.ts.net");
  });
});

describe("tailscale-peers match", () => {
  const snap = parseTailscaleStatusJson(fixtureStatus);

  it("matches host id remote-a to MagicDNS peer", () => {
    const host = resolveTailscaleHostForQuery(
      { hostId: "remote-a", sshEndpoint: "remote-a" },
      snap,
    );
    expect(host).toBe("remote-a.example.ts.net");
  });

  it("matches user@endpoint form", () => {
    const host = resolveTailscaleHostForQuery(
      { hostId: "mini", sshEndpoint: "me@remote-a" },
      snap,
    );
    expect(host).toBe("remote-a.example.ts.net");
  });

  it("does not invent a peer for unknown host", () => {
    expect(
      resolveTailscaleHostForQuery({ hostId: "nowhere", sshEndpoint: "nowhere" }, snap),
    ).toBeUndefined();
  });

  it("skips local host id", () => {
    expect(resolveTailscaleHostForQuery({ hostId: "local" }, snap)).toBeUndefined();
  });

  it("prefers online peer when labels collide weakly", () => {
    const peer = matchTailscalePeer({ hostId: "remote-a" }, snap);
    expect(peer?.online).toBe(true);
    expect(peer?.dnsName).toContain("remote-a");
  });

  it("endpointHostToken strips user@", () => {
    expect(endpointHostToken("user@remote-a")).toBe("remote-a");
    expect(endpointHostToken("remote-a")).toBe("remote-a");
  });

  it("does not match unknown hostId against HostName-less peers", () => {
    const bare = parseTailscaleStatusJson({
      Peer: {
        k: {
          DNSName: "ghost.tail.ts.net.",
          TailscaleIPs: ["100.64.0.40"],
          Online: true,
        },
      },
    });
    expect(
      resolveTailscaleHostForQuery({ hostId: "nowhere", sshEndpoint: "nowhere" }, bare),
    ).toBeUndefined();
  });

  it("short substring hostId does not steal Mac mini", () => {
    const hit = resolveTailscaleHostForQuery({ hostId: "mac", sshEndpoint: "mac" }, snap);
    // score floor should reject weak substring-only matches
    expect(hit).toBeUndefined();
  });
});
