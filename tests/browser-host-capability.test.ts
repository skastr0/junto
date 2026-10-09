import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  admitBrowserHostCapability,
  type BrowserHostCapabilityAuthority,
} from "../src/main/junto/browser/host-capability";

const host = (
  id: string,
  capabilities: RemoteHost["capabilities"],
  isThisMachine = false,
): RemoteHost => ({
  id,
  label: id,
  isThisMachine,
  ...(isThisMachine ? {} : { sshEndpoint: id }),
  capabilities,
});

const authority = (
  hosts: ReadonlyArray<RemoteHost>,
  machineName = "studio",
): BrowserHostCapabilityAuthority => ({
  findHost: (hostId) => hosts.find((candidate) => candidate.id === hostId),
  machineName: () => machineName,
});

describe("browser HostCapability admission", () => {
  it("admits a declared browser capability only on this machine", () => {
    const studio = host("studio", ["terminal", "browser", "hermes"], true);
    expect(admitBrowserHostCapability("studio", authority([studio]))).toEqual({
      ok: true,
      host: studio,
    });
  });

  it("never turns a page on another machine into a browser view here", () => {
    const studio = host("studio", ["browser", "terminal"], true);
    const atlas = host("atlas", ["browser", "terminal"]);
    expect(admitBrowserHostCapability("atlas", authority([studio, atlas]))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
    });
  });

  it("rejects another machine's row even when this machine's name matches it", () => {
    const atlas = host("atlas", ["browser", "terminal"]);
    expect(admitBrowserHostCapability("atlas", authority([atlas], "atlas"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
    });
  });

  it("fails closed until this machine's name is known", () => {
    const studio = host("studio", ["browser", "terminal"], true);
    expect(
      admitBrowserHostCapability("studio", {
        findHost: () => studio,
        machineName: () => undefined,
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "machine-name-unavailable",
    });
  });

  it("fails closed when the host is missing or its browser capability was removed", () => {
    expect(admitBrowserHostCapability("studio", authority([]))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "host-not-registered",
    });
    // This machine's own capabilities are a fact of the process, so only
    // another machine's row can lack the browser.
    expect(
      admitBrowserHostCapability("atlas", authority([host("atlas", ["terminal"])])),
    ).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "browser-not-declared",
    });
  });

  it("rejects malformed document-derived host ids before registry lookup", () => {
    for (const id of ["-studio", "local"]) {
      expect(admitBrowserHostCapability(id, authority([]))).toMatchObject({
        ok: false,
        code: "invalid",
        reason: "invalid-host",
      });
    }
  });
});
