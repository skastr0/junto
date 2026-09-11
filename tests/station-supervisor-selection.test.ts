import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StationSupervisor } from "../src/main/vellum-command/supervision/contract";
import {
  createStationSupervisorSelector,
  loadStationSupervisor,
  type StationSupervisorLoaders,
} from "../src/main/vellum-command/supervision/select";

const stubSupervisor = (provider: "launchd" | "systemd-user" | "standalone") =>
  ({
    metadata: {
      provider,
      displayName: provider,
      recovery: { title: "test", detail: "test" },
    },
    observe: vi.fn(),
    requestHandoff: vi.fn(),
  }) as unknown as StationSupervisor;

const makeLoaders = (): StationSupervisorLoaders => ({
  darwin: vi.fn(async () => stubSupervisor("launchd")),
  linux: vi.fn(async () => stubSupervisor("systemd-user")),
  standalone: vi.fn(async () => stubSupervisor("standalone")),
});

describe("station supervisor platform selection", () => {
  it.each([
    ["darwin", "darwin", "launchd"],
    ["linux", "linux", "systemd-user"],
    ["win32", "standalone", "standalone"],
    ["freebsd", "standalone", "standalone"],
  ] as const)(
    "loads only the %s provider branch",
    async (platform, selected, provider) => {
      const loaders = makeLoaders();
      const select = createStationSupervisorSelector(loaders);

      const supervisor = await select(platform);

      expect(supervisor.metadata.provider).toBe(provider);
      expect(loaders.darwin).toHaveBeenCalledTimes(
        selected === "darwin" ? 1 : 0,
      );
      expect(loaders.linux).toHaveBeenCalledTimes(
        selected === "linux" ? 1 : 0,
      );
      expect(loaders.standalone).toHaveBeenCalledTimes(
        selected === "standalone" ? 1 : 0,
      );
    },
  );

  it("keeps platform providers behind dynamic-import boundaries", () => {
    const source = readFileSync(
      join(process.cwd(), "src/main/vellum-command/supervision/select.ts"),
      "utf8",
    );

    expect(source).toMatch(/await import\(\s*["']\.\/darwin["']\s*\)/);
    expect(source).toMatch(/await import\(\s*["']\.\/systemd-user["']\s*\)/);
    expect(source).not.toMatch(/from\s+["']\.\/darwin["']/);
    expect(source).not.toMatch(/from\s+["']\.\/systemd-user["']/);
  });

  it("returns explicit standalone behavior on unsupported production platforms", async () => {
    const supervisor = await loadStationSupervisor("sunos");

    await expect(supervisor.observe()).resolves.toMatchObject({
      provider: "standalone",
      state: "unsupported",
      ownership: "none",
      failure: { kind: "unsupported" },
    });
  });
});
