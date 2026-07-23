import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import {
  applySettingsPatch,
  defaultSettings,
  SETTINGS_VERSION,
} from "../src/shared/settings";
import {
  applyAndValidatePatch,
  decodePatchInput,
  migrateSettingsDocument,
} from "../src/main/vellum/settings/migrate";
import { makeSettingsService } from "../src/main/vellum/settings/service";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const runEither = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect));

describe("settings contract", () => {
  it("defaultSettings is a valid v1 document", () => {
    const settings = defaultSettings();
    expect(settings.version).toBe(SETTINGS_VERSION);
    expect(settings.appearance.theme).toBe("deep-field");
    expect(settings.browser.maxVisibleSurfaces).toBe(2);
    expect(settings.browser.maxWarmSessions).toBe(3);
  });

  it("applySettingsPatch merges section fields", () => {
    const next = applySettingsPatch(defaultSettings(), {
      appearance: { reduceMotion: true },
      browser: { maxVisibleSurfaces: 4 },
    });
    expect(next.appearance.reduceMotion).toBe(true);
    expect(next.appearance.theme).toBe("deep-field");
    expect(next.browser.maxVisibleSurfaces).toBe(4);
    expect(next.browser.maxWarmSessions).toBe(3);
  });

  it("migrate soft-heals missing sections onto defaults", () => {
    const result = migrateSettingsDocument({ version: 1, appearance: { theme: "system" } });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.appearance.theme).toBe("system");
      expect(result.right.appearance.density).toBe("comfortable");
      expect(result.right.kernel.pulseLogRetention).toBe(20);
    }
  });

  it("migrate preserves the optional canonical station agent identity", () => {
    const result = migrateSettingsDocument({
      version: 1,
      station: {
        role: "remote",
        hostId: "studio",
        agentHostId: "fleet-studio",
        commandCenterRef: "local",
        supervisedPreferred: true,
      },
    });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.station.agentHostId).toBe("fleet-studio");
    }
  });

  it("migrate rejects future versions", () => {
    const result = migrateSettingsDocument({ version: 99 });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("unsupported");
    }
  });

  it("migrate rejects non-object documents", () => {
    const result = migrateSettingsDocument([]);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
  });

  it("decodePatchInput rejects out-of-range browser limits", () => {
    const result = decodePatchInput({ browser: { maxVisibleSurfaces: 999 } });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("validation");
    }
  });

  it("applyAndValidatePatch accepts a legal field patch", () => {
    const result = applyAndValidatePatch(defaultSettings(), {
      kernel: { pulseLogRetention: 40 },
    });
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.kernel.pulseLogRetention).toBe(40);
    }
  });
});

describe("settings service", () => {
  let dir: string;
  let path: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const fresh = async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    return makeSettingsService(path);
  };

  it("get creates defaults when file is missing", async () => {
    const svc = await fresh();
    const settings = await run(svc.get);
    expect(settings.version).toBe(1);
    const raw = JSON.parse(await readFile(path, "utf8")) as { version: number };
    expect(raw.version).toBe(1);
  });

  it("patch persists and notifies subscribers", async () => {
    const svc = await fresh();
    await run(svc.get);
    const seen: number[] = [];
    const unsub = svc.subscribe((s) => seen.push(s.browser.maxVisibleSurfaces));
    const next = await run(svc.patch({ browser: { maxVisibleSurfaces: 3 } }));
    expect(next.browser.maxVisibleSurfaces).toBe(3);
    expect(seen).toEqual([3]);
    const disk = JSON.parse(await readFile(path, "utf8")) as {
      browser: { maxVisibleSurfaces: number };
    };
    expect(disk.browser.maxVisibleSurfaces).toBe(3);
    unsub();
  });

  it("patch rejects invalid values without clobbering disk", async () => {
    const svc = await fresh();
    await run(svc.get);
    const before = await readFile(path, "utf8");
    const result = await runEither(svc.patch({ browser: { maxWarmSessions: 0 } }));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("validation");
    }
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("reset section restores defaults", async () => {
    const svc = await fresh();
    await run(svc.patch({ appearance: { theme: "system", reduceMotion: true } }));
    const reset = await run(svc.reset("appearance"));
    expect(reset.appearance.theme).toBe("deep-field");
    expect(reset.appearance.reduceMotion).toBe(false);
  });

  it("corrupt JSON refuses silent wipe", async () => {
    const svc = await fresh();
    await writeFile(path, "{not-json", "utf8");
    // Clear any accidental cache by using a new service instance on same path.
    const svc2 = makeSettingsService(path);
    const result = await runEither(svc2.get);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
    // File still the corrupt payload — not replaced with defaults.
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });

  it("doctor reports version when healthy without leaking absolute paths", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const svc = makeSettingsService(path, {
      probeSupervised: async () => "absent",
    });
    await run(svc.get);
    const check = await run(svc.doctor);
    expect(check.id).toBe("settings");
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("v1");
    expect(check.detail).not.toContain(path);
    expect(check.metadata?.version).toBe("1");
    expect(check.metadata?.role).toBe("unset");
    expect(check.metadata?.hostId).toBe("local");
    expect(check.metadata?.supervisedPreferred).toBe("false");
    expect(check.metadata?.supervisedInstalled).toBe("absent");
    expect(check.metadata?.supervisedAligned).toBe("true");
  });

  it("doctor warns when supervised is preferred but LaunchAgent is absent", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const svc = makeSettingsService(path, {
      probeSupervised: async () => "absent",
    });
    await run(svc.get);
    await run(
      svc.patch({
        station: { role: "remote", supervisedPreferred: true },
      }),
    );
    const check = await run(svc.doctor);
    expect(check.status).toBe("warning");
    expect(check.metadata?.role).toBe("remote");
    expect(check.metadata?.supervisedPreferred).toBe("true");
    expect(check.metadata?.supervisedInstalled).toBe("absent");
    expect(check.metadata?.supervisedAligned).toBe("false");
    expect(check.detail).toContain("app:install:supervised");
  });

  it("doctor is ok when preferred and LaunchAgent loaded", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const svc = makeSettingsService(path, {
      probeSupervised: async () => "installed",
    });
    await run(svc.get);
    await run(
      svc.patch({
        station: { role: "remote", hostId: "remote-a", supervisedPreferred: true },
      }),
    );
    const check = await run(svc.doctor);
    expect(check.status).toBe("ok");
    expect(check.metadata?.hostId).toBe("remote-a");
    expect(check.metadata?.supervisedInstalled).toBe("installed");
    expect(check.metadata?.supervisedAligned).toBe("true");
  });

  it("rejects oversized settings files", async () => {
    const svc = await fresh();
    await writeFile(path, "x".repeat(65 * 1024), "utf8");
    const svc2 = makeSettingsService(path);
    const result = await runEither(svc2.get);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
  });

  it("rejects invalid defaultCanvas names", async () => {
    const svc = await fresh();
    await run(svc.get);
    const result = await runEither(svc.patch({ canvas: { defaultCanvas: "../etc" } }));
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects version below floor", () => {
    const result = migrateSettingsDocument({ version: 0 });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
  });
});
