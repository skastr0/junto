import { describe, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  admitBrowserHostCapability,
  type BrowserHostCapabilityAuthority,
} from "../src/main/vellum/browser/host-capability";

const host = (
  id: string,
  capabilities: RemoteHost["capabilities"],
  kind: RemoteHost["kind"] = id === "local" ? "local" : "remote",
): RemoteHost => ({
  id,
  label: id,
  kind,
  ...(kind === "remote" ? { endpoint: id } : {}),
  capabilities,
});

const authority = (
  hosts: ReadonlyArray<RemoteHost>,
  stationHostId = "local",
): BrowserHostCapabilityAuthority => ({
  findHost: (hostId) => hosts.find((candidate) => candidate.id === hostId),
  station: () => ({ hostId: stationHostId, role: stationHostId === "local" ? "command-center" : "remote" }),
});

describe("browser HostCapability admission", () => {
  it("admits a declared browser capability only on the exact physical station", () => {
    const local = host("local", ["terminal", "browser", "herdr", "hermes"]);
    expect(admitBrowserHostCapability("local", authority([local]))).toEqual({
      ok: true,
      host: local,
    });

    const studio = host("studio", ["browser", "terminal"]);
    expect(admitBrowserHostCapability("studio", authority([studio], "studio"))).toEqual({
      ok: true,
      host: studio,
    });
  });

  it("never turns a selected remote page into a local browser view", () => {
    const studio = host("studio", ["browser", "terminal"]);
    expect(admitBrowserHostCapability("studio", authority([studio], "local"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
    });
  });

  it("rejects a remote registry target even when Command Center settings name it", () => {
    const studio = host("studio", ["browser", "terminal"]);
    expect(
      admitBrowserHostCapability(
        "studio",
        {
          findHost: (hostId) => hostId === studio.id ? studio : undefined,
          station: () => ({ hostId: "studio", role: "command-center" }),
        },
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "physical-host-mismatch",
    });
  });

  it("fails closed until durable physical-station identity is ready", () => {
    const local = host("local", ["browser", "terminal"]);
    expect(
      admitBrowserHostCapability("local", {
        findHost: () => local,
        station: () => undefined,
      }),
    ).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "station-identity-unavailable",
    });
  });

  it("fails closed when the host is missing or its browser capability was removed", () => {
    expect(admitBrowserHostCapability("studio", authority([], "studio"))).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "host-not-registered",
    });
    expect(
      admitBrowserHostCapability(
        "studio",
        authority([host("studio", ["terminal"])], "studio"),
      ),
    ).toMatchObject({
      ok: false,
      code: "unsupported_capability",
      reason: "browser-not-declared",
    });
  });

  it("rejects malformed document-derived host ids before registry lookup", () => {
    expect(admitBrowserHostCapability("-studio", authority([]))).toMatchObject({
      ok: false,
      code: "invalid",
      reason: "invalid-host",
    });
  });
});
