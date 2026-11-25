/**
 * One literal host for a link route: a DNS name, an IPv4 address, or a
 * bracket-free, canonical IPv6 address. The wire and every core route gate
 * call the same predicate, so a spelling cannot pass one and fail another.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { canonicalLiteralHost, isLiteralHost, literalHostProblem } from "../src/shared/literal-host";
import { MachineLinkRoute } from "../src/shared/machine-link";

const route = (host: string) => Schema.decodeUnknownResult(MachineLinkRoute)({ machine: "vps", user: "ops", host, port: 22 });

describe("a link route's literal host", () => {
  it.each(["vps.tailnet.ts.net", "203.0.113.7", "::1", "2001:db8::1", "2001:DB8:0::1"])("admits %s", (host) => {
    expect(isLiteralHost(host)).toBe(true);
    expect(route(host)._tag).toBe("Success");
  });

  it.each([
    ["brackets", "[2001:db8::1]"],
    ["a zone", "fe80::1%en0"],
    ["an IPv4-mapped address", "::ffff:203.0.113.7"],
    ["the unspecified address", "::"],
    ["a multicast address", "ff02::1"],
    ["a link-local address", "fe80::1"],
  ])("refuses %s", (_what, host) => {
    expect(isLiteralHost(host)).toBe(false);
    expect(route(host)._tag).toBe("Failure");
  });

  it("stores one canonical spelling for one address", () => {
    expect(canonicalLiteralHost("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(canonicalLiteralHost("2001:0db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(canonicalLiteralHost("::1")).toBe("::1");
    expect(canonicalLiteralHost("vps.tailnet.ts.net")).toBe("vps.tailnet.ts.net");
  });

  it("names why a refused route cannot be dialed, without echoing it", () => {
    expect(literalHostProblem("::ffff:203.0.113.7")).toBe("mapped");
    expect(literalHostProblem("fe80::1")).toBe("link-local");
    expect(literalHostProblem("vps.tailnet.ts.net")).toBeUndefined();
  });
});
