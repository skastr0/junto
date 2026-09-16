import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_MAX_EGRESS_HAPPY_EYEBALLS_INFLIGHT,
  BROWSER_MAX_PENDING_DNS_HOSTS,
} from "../src/shared/browser-limits";
import { makeBrowserTestOnlyExactOriginGrant } from "../src/main/junto/browser/web-policy";
import {
  approveResolvedEndpoints,
  classifyEgressAuthority,
  classifyEgressHttpUrl,
  connectApprovedEndpoints,
  createBoundedHostResolver,
  type ApprovedEgressEndpoint,
  type EgressSocket,
} from "../src/main/junto/browser/egress-policy";

describe("browser egress destination policy", () => {
  it("admits public literals and DNS names, denies private and metadata", () => {
    expect(classifyEgressHttpUrl("https://1.1.1.1/")).toMatchObject({
      kind: "literal",
      endpoint: { address: "1.1.1.1", family: "ipv4" },
    });
    expect(classifyEgressHttpUrl("https://example.com/path")).toEqual({
      kind: "resolve",
      hostname: "example.com",
      port: 443,
    });
    expect(classifyEgressHttpUrl("https://user:secret@example.com/")).toEqual({
      kind: "deny",
      reason: "credentials",
    });
    expect(classifyEgressHttpUrl("http://127.0.0.1/")).toEqual({
      kind: "deny",
      reason: "non_public_ip",
    });
    expect(classifyEgressHttpUrl("http://169.254.169.254/latest/meta-data")).toEqual({
      kind: "deny",
      reason: "non_public_ip",
    });
    expect(classifyEgressAuthority("fd00:ec2::254", 80)).toEqual({
      kind: "deny",
      reason: "non_public_ip",
    });
    expect(classifyEgressAuthority("::ffff:127.0.0.1", 80).kind).toBe("deny");
  });

  it("preserves the test-only exact origin as a grant, not as public", () => {
    const grant = makeBrowserTestOnlyExactOriginGrant("http://127.0.0.1:49152");
    expect(classifyEgressHttpUrl("http://127.0.0.1:49152/fixture", grant)).toEqual({
      kind: "grant",
      host: "127.0.0.1",
      port: 49152,
    });
    expect(classifyEgressAuthority("127.0.0.1", 49152, grant)).toEqual({
      kind: "grant",
      host: "127.0.0.1",
      port: 49152,
    });
    expect(classifyEgressAuthority("127.0.0.1", 49153, grant).kind).toBe("deny");
  });

  it("rejects mixed, empty, invalid, and private resolver batches", () => {
    expect(approveResolvedEndpoints([])).toBeUndefined();
    expect(
      approveResolvedEndpoints([
        { address: "93.184.216.34" },
        { address: "10.0.0.1" },
      ]),
    ).toBeUndefined();
    expect(approveResolvedEndpoints([{ address: "not-an-ip" }])).toBeUndefined();
    expect(approveResolvedEndpoints([{ address: "fec0::1" }])).toBeUndefined();
    expect(approveResolvedEndpoints([{ address: "169.254.169.254" }])).toBeUndefined();
    expect(approveResolvedEndpoints([{ address: "fd00:ec2::254" }])).toBeUndefined();
    expect(approveResolvedEndpoints([{ address: "93.184.216.34" }, { address: "2606:4700:4700::1111" }])).toEqual([
      { address: "93.184.216.34", family: "ipv4" },
      { address: "2606:4700:4700::1111", family: "ipv6" },
    ]);
  });

  it("deduplicates one shared DNS lookup", async () => {
    const resolveHost = vi.fn(
      async () => ({ endpoints: [{ address: "93.184.216.34", family: "ipv4" }] }),
    );
    const resolve = createBoundedHostResolver(resolveHost);
    const first = resolve("example.com");
    const second = resolve("example.com");
    expect(resolveHost).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual([{ address: "93.184.216.34", family: "ipv4" }]);
    await expect(second).resolves.toEqual([{ address: "93.184.216.34", family: "ipv4" }]);
  });

  it("caps unique in-flight DNS work", async () => {
    const hanging = createBoundedHostResolver(() => new Promise(() => undefined));
    const pending = Array.from({ length: BROWSER_MAX_PENDING_DNS_HOSTS }, (_, index) =>
      hanging(`host-${String(index)}.example.net`),
    );
    await expect(hanging("excess.example.net")).resolves.toBeUndefined();
    expect(pending).toHaveLength(BROWSER_MAX_PENDING_DNS_HOSTS);
  });

  it("pins connect to the approved numeric batch even if hostname lookup would return loopback", async () => {
    const publicEndpoint: ApprovedEgressEndpoint = { address: "93.184.216.34", family: "ipv4" };
    const hostnameLookups: string[] = [];
    const dialed: string[] = [];
    const socket: EgressSocket = {
      remoteAddress: "93.184.216.34",
      destroyed: false,
      destroy: () => undefined,
    };
    const connected = await connectApprovedEndpoints(
      [publicEndpoint],
      80,
      async (endpoint, port) => {
        if (endpoint.address === "example.com") hostnameLookups.push(endpoint.address);
        dialed.push(`${endpoint.address}:${String(port)}`);
        return socket;
      },
    );
    expect(connected).toBe(socket);
    expect(dialed).toEqual(["93.184.216.34:80"]);
    expect(hostnameLookups).toEqual([]);
  });

  it("refuses a peer-address mismatch and does not hostname-dial", async () => {
    const ipv4: ApprovedEgressEndpoint = { address: "1.1.1.1", family: "ipv4" };
    await expect(
      connectApprovedEndpoints([ipv4], 80, async () => ({
        remoteAddress: "127.0.0.1",
        destroyed: false,
        destroy: () => undefined,
      })),
    ).rejects.toThrow(/peer address mismatch/);
  });

  it("bounds concurrent happy-eyeballs dials instead of fanning out every answer", async () => {
    const endpoints: ApprovedEgressEndpoint[] = [
      { address: "2606:4700:4700::1111", family: "ipv6" },
      { address: "2606:4700:4700::2222", family: "ipv6" },
      { address: "93.184.216.34", family: "ipv4" },
      { address: "1.2.3.4", family: "ipv4" },
      { address: "5.6.7.8", family: "ipv4" },
      { address: "9.10.11.12", family: "ipv4" },
    ];
    let liveDials = 0;
    let peakDials = 0;
    let dialCalls = 0;
    await expect(
      connectApprovedEndpoints(endpoints, 80, async () => {
        dialCalls += 1;
        liveDials += 1;
        peakDials = Math.max(peakDials, liveDials);
        try {
          // Slow enough that the Happy Eyeballs stagger opens the next
          // attempt while this one is still in flight.
          await new Promise((resolve) => setTimeout(resolve, 300));
          throw new Error("dial refused");
        } finally {
          liveDials -= 1;
        }
      }),
    ).rejects.toThrow(/dial refused/);
    expect(dialCalls).toBe(endpoints.length);
    expect(peakDials).toBe(BROWSER_MAX_EGRESS_HAPPY_EYEBALLS_INFLIGHT);
  });

  it("refuses to dial when the socket budget withholds permission", async () => {
    const endpoints: ApprovedEgressEndpoint[] = [
      { address: "93.184.216.34", family: "ipv4" },
      { address: "1.2.3.4", family: "ipv4" },
    ];
    let dialCalls = 0;
    await expect(
      connectApprovedEndpoints(
        endpoints,
        80,
        async () => {
          dialCalls += 1;
          return { remoteAddress: "93.184.216.34", destroyed: false, destroy: () => undefined };
        },
        undefined,
        () => false,
      ),
    ).rejects.toThrow(/budget/);
    expect(dialCalls).toBe(0);
  });

  it("keeps an already-won socket when the budget refuses further dials", async () => {
    const endpoints: ApprovedEgressEndpoint[] = [
      { address: "93.184.216.34", family: "ipv4" },
      { address: "1.2.3.4", family: "ipv4" },
      { address: "5.6.7.8", family: "ipv4" },
    ];
    const winner: EgressSocket = {
      remoteAddress: "93.184.216.34",
      destroyed: false,
      destroy: () => undefined,
    };
    let dialCalls = 0;
    let permits = 1;
    const connected = await connectApprovedEndpoints(
      endpoints,
      80,
      async () => {
        dialCalls += 1;
        return winner;
      },
      undefined,
      () => permits-- > 0,
    );
    expect(connected).toBe(winner);
    expect(dialCalls).toBe(1);
  });
});
