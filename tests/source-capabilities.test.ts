import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectSourceCapabilities } from "../src/main/vellum/source-capabilities";

// Detection mirrors each SDK's own resolution order (env var -> config
// file). It decides which private sources the snapshot fan-out fetches and
// which surfaces the renderer shows at all; a bare machine must detect as
// nothing configured.

const emptyHome = () => mkdtempSync(join(tmpdir(), "vellum-caps-"));

describe("detectSourceCapabilities", () => {
  it("reports nothing configured on a bare machine", () => {
    expect(detectSourceCapabilities({}, emptyHome())).toEqual({
      tower: false,
      quasar: false,
      booth: false,
    });
  });

  it("env vars alone configure a source", () => {
    const home = emptyHome();
    expect(detectSourceCapabilities({ TOWER_CONTROL_URL: "https://x" }, home).tower).toBe(true);
    expect(detectSourceCapabilities({ TOWER_CONTROL_TOKEN: "t" }, home).tower).toBe(true);
    expect(detectSourceCapabilities({ QUASAR_SERVER_URL: "https://x" }, home).quasar).toBe(true);
    expect(detectSourceCapabilities({ BOOTH_API_URL: "https://x" }, home).booth).toBe(true);
    expect(detectSourceCapabilities({ BOOTH_CONTROL_TOKEN: "t" }, home).booth).toBe(true);
  });

  it("each SDK's config file configures its source", () => {
    const home = emptyHome();
    mkdirSync(join(home, ".tower-control"), { recursive: true });
    writeFileSync(join(home, ".tower-control", "config.json"), "{}");
    mkdirSync(join(home, ".config", "quasar"), { recursive: true });
    writeFileSync(join(home, ".config", "quasar", "config.json"), "{}");
    mkdirSync(join(home, ".booth-control"), { recursive: true });
    writeFileSync(join(home, ".booth-control", "config.json"), "{}");
    expect(detectSourceCapabilities({}, home)).toEqual({
      tower: true,
      quasar: true,
      booth: true,
    });
  });

  it("config-path override env vars are honored", () => {
    const home = emptyHome();
    const quasarConfig = join(home, "quasar-elsewhere.json");
    const boothConfig = join(home, "booth-elsewhere.json");
    writeFileSync(quasarConfig, "{}");
    writeFileSync(boothConfig, "{}");
    const capabilities = detectSourceCapabilities(
      { QUASAR_CONFIG: quasarConfig, BOOTH_CONTROL_CONFIG: boothConfig },
      home,
    );
    expect(capabilities).toEqual({ tower: false, quasar: true, booth: true });
  });
});
