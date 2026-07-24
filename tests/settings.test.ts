import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import {
  topologyFromStation,
  topologyPathsForSettings,
  writeTopologySeal,
} from "../src/main/vellum/settings/topology-seal";

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
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("repairs legacy group-readable settings before reading", async () => {
    const svc = await fresh();
    await writeFile(path, `${JSON.stringify(defaultSettings())}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await chmod(path, 0o664);

    await run(svc.get);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
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
      svc.setStationTopology({
        role: "remote",
        supervisedPreferred: true,
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
      svc.setStationTopology({
        role: "remote",
        hostId: "remote-a",
        supervisedPreferred: true,
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

  it("rejects station topology via generic settingsPatch", async () => {
    const svc = await fresh();
    await run(svc.get);
    const result = await runEither(
      svc.patch({ station: { role: "command-center" } }),
    );
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toContain("settingsSetStationTopology");
    }
    const settings = await run(svc.get);
    expect(settings.station.role).toBe("");
  });

  it("setStationTopology seals role and reloads sealed topology", async () => {
    const svc = await fresh();
    await run(svc.get);
    const next = await run(
      svc.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    expect(next.station.role).toBe("command-center");
    const paths = topologyPathsForSettings(path);
    await stat(paths.key);
    await stat(paths.seal);

    // Cold load — seal must admit the role.
    const svc2 = makeSettingsService(path);
    const reloaded = await run(svc2.get);
    expect(reloaded.station.role).toBe("command-center");
    expect(reloaded.station.hostId).toBe("local");
  });

  it("tampered topology fields fail closed to integrity-failed lock", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(
      svc.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );

    // Offline mint: rewrite role without resealing.
    const disk = JSON.parse(await readFile(path, "utf8")) as ReturnType<
      typeof defaultSettings
    >;
    const tampered = {
      ...disk,
      station: {
        ...disk.station,
        role: "remote" as const,
        commandCenterRef: "evil-cc",
        supervisedPreferred: true,
      },
    };
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    const svc2 = makeSettingsService(path);
    const admitted = await run(svc2.get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
    expect(admitted.station.commandCenterRef).toBe("");
    expect(admitted.station.supervisedPreferred).toBe(false);

    // Disk rewritten fail-closed as integrity-failed (not first-run ok).
    const after = JSON.parse(await readFile(path, "utf8")) as {
      station: { role: string; topologyIntegrity: string };
    };
    expect(after.station.role).toBe("");
    expect(after.station.topologyIntegrity).toBe("failed");
  });

  it("tampered seal mac fails closed to integrity-failed", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(svc.setStationTopology({ role: "remote", hostId: "box", commandCenterRef: "cc" }));

    const paths = topologyPathsForSettings(path);
    await writeFile(
      paths.seal,
      `${JSON.stringify({ version: 1, alg: "hmac-sha256", mac: "not-a-real-mac" })}\n`,
      "utf8",
    );

    const svc2 = makeSettingsService(path);
    const admitted = await run(svc2.get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
  });

  it("missing seal after key exists fails closed to integrity-failed", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(svc.setStationTopology({ role: "command-center" }));

    const paths = topologyPathsForSettings(path);
    await rm(paths.seal);

    const disk = JSON.parse(await readFile(path, "utf8")) as ReturnType<
      typeof defaultSettings
    >;
    expect(disk.station.role).toBe("command-center");

    const svc2 = makeSettingsService(path);
    const admitted = await run(svc2.get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
  });

  it("integrity-failed blocks setStationTopology promotion to command-center", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(svc.setStationTopology({ role: "command-center", hostId: "local" }));

    // Tamper to force integrity-failed lock.
    const paths = topologyPathsForSettings(path);
    await writeFile(
      paths.seal,
      `${JSON.stringify({ version: 1, alg: "hmac-sha256", mac: "broken" })}\n`,
      "utf8",
    );
    const locked = makeSettingsService(path);
    const admitted = await run(locked.get);
    expect(admitted.station.topologyIntegrity).toBe("failed");
    expect(admitted.station.role).toBe("");

    const promote = await runEither(
      locked.setStationTopology({ role: "command-center", hostId: "local" }),
    );
    expect(Either.isLeft(promote)).toBe(true);
    if (Either.isLeft(promote)) {
      expect(promote.left.code).toBe("validation");
      expect(promote.left.message).toMatch(/integrity failed/i);
    }
    const still = await run(locked.get);
    expect(still.station.role).toBe("");
    expect(still.station.topologyIntegrity).toBe("failed");
  });

  it("bootstrap admits unsealed topology once then seals", async () => {
    // Simulate CC configure-remote stamp: settings with role, no seal material.
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const stamped = {
      ...defaultSettings(),
      station: {
        ...defaultSettings().station,
        role: "remote" as const,
        hostId: "studio",
        commandCenterRef: "local",
        supervisedPreferred: true,
      },
    };
    await writeFile(path, `${JSON.stringify(stamped, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const svc = makeSettingsService(path);
    const admitted = await run(svc.get);
    expect(admitted.station.role).toBe("remote");
    expect(admitted.station.hostId).toBe("studio");

    const paths = topologyPathsForSettings(path);
    await stat(paths.key);
    await stat(paths.seal);

    // Subsequent offline role flip fails closed (integrity-failed, not first-run).
    const disk = JSON.parse(await readFile(path, "utf8")) as ReturnType<
      typeof defaultSettings
    >;
    const flipped = {
      ...disk,
      station: {
        ...disk.station,
        role: "command-center" as const,
      },
    };
    await writeFile(path, `${JSON.stringify(flipped, null, 2)}\n`, "utf8");
    const svc2 = makeSettingsService(path);
    const locked = await run(svc2.get);
    expect(locked.station.role).toBe("");
    expect(locked.station.topologyIntegrity).toBe("failed");
  });

  it("refuses ambient reset of station topology", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(svc.setStationTopology({ role: "remote", hostId: "box" }));
    const result = await runEither(svc.reset("station"));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("validation");
      expect(result.left.message).toMatch(/transfer ceremony/i);
    }
    const still = await run(svc.get);
    expect(still.station.role).toBe("remote");
  });

  it("setStationTopology refuses remote → command-center and remote → empty", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(
      svc.setStationTopology({
        role: "remote",
        hostId: "box",
        commandCenterRef: "cc",
      }),
    );

    const promote = await runEither(
      svc.setStationTopology({ role: "command-center", hostId: "box" }),
    );
    expect(Either.isLeft(promote)).toBe(true);
    if (Either.isLeft(promote)) {
      expect(promote.left.code).toBe("validation");
      expect(promote.left.message).toMatch(/transfer ceremony/i);
    }

    const clear = await runEither(svc.setStationTopology({ role: "" }));
    expect(Either.isLeft(clear)).toBe(true);
    if (Either.isLeft(clear)) {
      expect(clear.left.code).toBe("validation");
      expect(clear.left.message).toMatch(/transfer ceremony/i);
    }

    const still = await run(svc.get);
    expect(still.station.role).toBe("remote");
    expect(still.station.hostId).toBe("box");
    expect(still.station.commandCenterRef).toBe("cc");
  });

  it("full settings reset preserves sealed station topology", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(
      svc.setStationTopology({ role: "command-center", hostId: "local" }),
    );
    await run(svc.patch({ browser: { maxVisibleSurfaces: 4 } }));
    const reset = await run(svc.reset());
    expect(reset.station.role).toBe("command-center");
    expect(reset.browser.maxVisibleSurfaces).toBe(
      defaultSettings().browser.maxVisibleSurfaces,
    );
  });

  it("app-written seal matches sealed material helper", async () => {
    const svc = await fresh();
    await run(svc.get);
    const next = await run(
      svc.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    // Rewriting the same seal is a no-op admit.
    await writeTopologySeal(path, topologyFromStation(next.station));
    const svc2 = makeSettingsService(path);
    expect((await run(svc2.get)).station.role).toBe("command-center");
  });

  it("sealed CC delete only settings.json → topologyIntegrity failed (not first-run)", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(
      svc.setStationTopology({
        role: "command-center",
        hostId: "local",
      }),
    );
    const paths = topologyPathsForSettings(path);
    await stat(paths.key);
    await stat(paths.seal);
    await rm(path);

    const svc2 = makeSettingsService(path);
    const admitted = await run(svc2.get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
    // Evidence preserved (key still present as regular file after reseal).
    await stat(paths.key);
    await stat(paths.seal);
    const disk = JSON.parse(await readFile(path, "utf8")) as {
      station: { role: string; topologyIntegrity: string };
    };
    expect(disk.station.role).toBe("");
    expect(disk.station.topologyIntegrity).toBe("failed");
  });

  it("sealed Remote delete only settings.json → topologyIntegrity failed", async () => {
    const svc = await fresh();
    await run(svc.get);
    await run(
      svc.setStationTopology({
        role: "remote",
        hostId: "studio",
        commandCenterRef: "local",
        supervisedPreferred: true,
      }),
    );
    await rm(path);
    const admitted = await run(makeSettingsService(path).get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
  });

  it("settings missing with key-only evidence → topologyIntegrity failed", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const paths = topologyPathsForSettings(path);
    // Key only — no settings, no seal.
    await writeFile(paths.key, Buffer.alloc(32, 7), { mode: 0o600 });

    const admitted = await run(makeSettingsService(path).get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
    await stat(paths.key);
  });

  it("settings missing with seal-only evidence → topologyIntegrity failed", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const paths = topologyPathsForSettings(path);
    await writeFile(
      paths.seal,
      `${JSON.stringify({ version: 1, alg: "hmac-sha256", mac: "orphan" })}\n`,
      { mode: 0o600 },
    );

    const admitted = await run(makeSettingsService(path).get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("failed");
  });

  it("all of settings/key/seal absent → genuine first-run ok", async () => {
    dir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
    path = join(dir, "settings.json");
    const admitted = await run(makeSettingsService(path).get);
    expect(admitted.station.role).toBe("");
    expect(admitted.station.topologyIntegrity).toBe("ok");
    // First-run creates defaults + seals empty topology.
    const paths = topologyPathsForSettings(path);
    await stat(path);
    await stat(paths.key);
    await stat(paths.seal);
  });

});
