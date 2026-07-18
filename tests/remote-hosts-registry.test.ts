import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultRemoteHostsDocument, hermesKeyFor } from "../src/shared/remote-hosts";
import {
  makeHostsRegistry,
  resetDefaultHostsRegistryForTests,
} from "../src/main/vellum/hosts/registry";
import {
  findHostByHermesId,
  hostsWithCapability,
  setHostsSnapshot,
} from "../src/main/vellum/hosts/snapshot";
import { isKnownHerdrHost, listHerdrHosts } from "../src/main/vellum/herdr/hosts";
import { acpVerboseLogging } from "../src/main/vellum/chat/acp-client";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  resetDefaultHostsRegistryForTests();
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  delete process.env.VELLUM_ACP_VERBOSE;
  delete process.env.VELLUM_DEBUG;
});

describe("remote hosts registry", () => {
  it("seeds only local when the file is missing (no product remote hardcoding)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    const hosts = await registry.list();
    expect(hosts.map((host) => host.id)).toEqual(["local"]);
    expect(hosts.every((host) => host.kind === "local" || host.endpoint)).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw).version).toBe(1);
  });

  it("upserts an remote host and rejects removing local", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-"));
    dirs.push(root);
    const registry = makeHostsRegistry(join(root, "hosts.json"));
    const hosts = await registry.upsert({
      id: "studio",
      label: "studio mini",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["herdr", "hermes"],
    });
    expect(hosts.some((host) => host.id === "studio")).toBe(true);
    await expect(registry.remove("local")).rejects.toMatchObject({ code: "conflict" });
  });

  it("resolves optional hermesId aliases without product-specific defaults", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "fleet-1",
        label: "Fleet One",
        kind: "remote",
        endpoint: "fleet-1",
        capabilities: ["herdr", "hermes"],
        hermesId: "f1",
      },
    ]);
    const host = findHostByHermesId("f1");
    expect(host?.id).toBe("fleet-1");
    expect(hermesKeyFor(host!)).toBe("f1");
    expect(hostsWithCapability("herdr").map((h) => h.id)).toEqual(["local", "fleet-1"]);
    expect(listHerdrHosts().map((h) => h.id)).toEqual(["local", "fleet-1"]);
    expect(isKnownHerdrHost("studio")).toBe(false);
  });
});

describe("acp verbose logging gate", () => {
  it("defaults off", () => {
    expect(acpVerboseLogging()).toBe(false);
  });

  it("enables via VELLUM_ACP_VERBOSE", () => {
    process.env.VELLUM_ACP_VERBOSE = "1";
    expect(acpVerboseLogging()).toBe(true);
  });
});
