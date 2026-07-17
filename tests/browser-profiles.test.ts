import { execFile } from "node:child_process";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Either } from "effect";
import {
  listProfileDirs,
  makeBrowserProfileService,
  type BrowserProfilePendingWipe,
  type BrowserProfileWipeLifecycle,
  type BrowserProfileWipeOutcome,
} from "../src/main/vellum/browser/profiles";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "../src/shared/browser-limits";

const FIXED_TIME = "2026-07-17T12:00:00.000Z";
const MODE_MASK = 0o777;
const execFileAsync = promisify(execFile);

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);
const runEither = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(effect));

const legacyConfig = () => ({
  defaultProfile: "personal",
  canvasDefaults: { portfolio: "work" },
  maxWarmSessions: 3,
  maxVisibleSurfaces: 2,
  profiles: [
    { id: "personal", label: "Personal", createdAt: FIXED_TIME },
    { id: "work", label: "Work", createdAt: FIXED_TIME },
  ],
});

const wipePaths = (root: string, profileId: string) => ({
  userDataPath: join(root, "electron-user-data"),
  sessionDataPath: join(root, "electron-user-data", "Session Data"),
  storagePath: join(root, "electron-user-data", "Session Data", "Partitions", profileId),
});

describe("browser profile registry", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  const freshRoot = async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-"));
    return root;
  };

  const service = async (lifecycle?: BrowserProfileWipeLifecycle) => {
    await freshRoot();
    return makeBrowserProfileService(root, {
      ...(lifecycle ? { wipeLifecycle: lifecycle } : {}),
      now: () => new Date(FIXED_TIME),
    });
  };

  const lifecycle = (
    executeLive: (
      pending: BrowserProfilePendingWipe,
    ) => Promise<BrowserProfileWipeOutcome> = async () => ({ status: "complete" }),
    recoverCold: (pending: BrowserProfilePendingWipe) => Promise<void> = async () => undefined,
  ): BrowserProfileWipeLifecycle => ({
    prepare: async ({ profileId }) => wipePaths(root, profileId),
    executeLive,
    recoverCold,
  });

  it("creates a versioned owner-only registry and profile directories", async () => {
    const registry = await service();
    const config = await run(registry.initialize);

    expect(config.defaultProfile).toBe("personal");
    expect(config.profiles.map((profile) => profile.id)).toEqual(["personal", "work"]);
    const disk = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    expect(disk).toMatchObject({ version: 1, phase: "ready" });
    for (const path of [
      root,
      join(root, "profiles"),
      join(root, "profiles", "personal"),
      join(root, "profiles", "work"),
    ]) {
      expect((await lstat(path)).mode & MODE_MASK).toBe(0o700);
    }
    expect((await lstat(join(root, "config.json"))).mode & MODE_MASK).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect((await listProfileDirs(root)).sort()).toEqual(["personal", "work"]);
  });

  it("repairs owner file and directory modes", async () => {
    const registry = await service();
    await run(registry.initialize);
    const paths = [
      root,
      join(root, "profiles"),
      join(root, "profiles", "personal"),
      join(root, "profiles", "work"),
    ];
    for (const path of paths) await chmod(path, 0o755);
    await chmod(join(root, "config.json"), 0o644);

    await run(makeBrowserProfileService(root).readConfig);

    for (const path of paths) expect((await lstat(path)).mode & MODE_MASK).toBe(0o700);
    expect((await lstat(join(root, "config.json"))).mode & MODE_MASK).toBe(0o600);
  });

  it("strictly migrates the exact legacy file without changing its semantics", async () => {
    await freshRoot();
    await writeFile(join(root, "config.json"), `${JSON.stringify(legacyConfig(), null, 2)}\n`, {
      mode: 0o600,
    });
    const registry = makeBrowserProfileService(root);

    const config = await run(registry.readConfig);

    expect(config).toEqual(legacyConfig());
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toEqual({
      version: 1,
      phase: "ready",
      ...legacyConfig(),
    });
  });

  it.each([
    ["malformed JSON", "{not-json"],
    ["oversized input", "x".repeat(64 * 1024 + 1)],
    [
      "duplicate profile ids",
      JSON.stringify({
        ...legacyConfig(),
        profiles: [
          { id: "personal", createdAt: FIXED_TIME },
          { id: "personal", createdAt: FIXED_TIME },
        ],
      }),
    ],
    ["missing default", JSON.stringify({ ...legacyConfig(), defaultProfile: "missing" })],
    [
      "invalid canvas default",
      JSON.stringify({ ...legacyConfig(), canvasDefaults: { "../escape": "work" } }),
    ],
    [
      "invalid timestamp",
      JSON.stringify({
        ...legacyConfig(),
        profiles: [
          { id: "personal", createdAt: "yesterday" },
          { id: "work", createdAt: FIXED_TIME },
        ],
      }),
    ],
    [
      "out-of-range limit",
      JSON.stringify({
        ...legacyConfig(),
        maxWarmSessions: BROWSER_MAX_WARM_SESSIONS_HARD + 1,
      }),
    ],
    ["unknown key", JSON.stringify({ ...legacyConfig(), surprise: true })],
  ])("rejects %s without replacing the file", async (_name, raw) => {
    await freshRoot();
    await writeFile(join(root, "config.json"), raw, { mode: 0o600 });
    const registry = makeBrowserProfileService(root);

    const result = await runEither(registry.readConfig);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(raw);
  });

  it("rejects symlinked config and profile directories without touching their targets", async () => {
    await freshRoot();
    const configTarget = join(root, "config-target.json");
    await writeFile(configTarget, `${JSON.stringify(legacyConfig())}\n`, { mode: 0o600 });
    await symlink(configTarget, join(root, "config.json"));

    const configResult = await runEither(makeBrowserProfileService(root).readConfig);
    expect(Either.isLeft(configResult)).toBe(true);
    if (Either.isLeft(configResult)) expect(configResult.left.code).toBe("corrupt");
    expect(await readFile(configTarget, "utf8")).toBe(`${JSON.stringify(legacyConfig())}\n`);

    await rm(join(root, "config.json"));
    const registry = makeBrowserProfileService(root);
    await run(registry.initialize);
    const external = join(root, "external-profile");
    await mkdir(external);
    await writeFile(join(external, "sentinel"), "preserve");
    await rmdir(join(root, "profiles", "work"));
    await symlink(external, join(root, "profiles", "work"));

    const profileResult = await runEither(makeBrowserProfileService(root).readConfig);
    expect(Either.isLeft(profileResult)).toBe(true);
    if (Either.isLeft(profileResult)) expect(profileResult.left.code).toBe("corrupt");
    expect(await readFile(join(external, "sentinel"), "utf8")).toBe("preserve");
    expect(await listProfileDirs(root)).toEqual([]);
  });

  it("rejects a multiply-linked config file without changing either link", async () => {
    await freshRoot();
    const config = join(root, "config.json");
    const secondLink = join(root, "config-hardlink.json");
    const raw = `${JSON.stringify(legacyConfig())}\n`;
    await writeFile(config, raw, { mode: 0o600 });
    await link(config, secondLink);

    const result = await runEither(makeBrowserProfileService(root).readConfig);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    expect(await readFile(config, "utf8")).toBe(raw);
    expect(await readFile(secondLink, "utf8")).toBe(raw);
  });

  it("rejects a config FIFO without blocking startup", async () => {
    await freshRoot();
    await execFileAsync("mkfifo", [join(root, "config.json")]);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runEither(makeBrowserProfileService(root).readConfig),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("config FIFO read blocked")), 1_000);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
  });

  it("removes bounded owner-only orphan temps but rejects a temp symlink", async () => {
    const registry = await service();
    await run(registry.initialize);
    const orphan = join(root, ".config.00000000-0000-4000-8000-000000000000.tmp");
    await writeFile(orphan, "partial", { mode: 0o644 });

    await run(makeBrowserProfileService(root).readConfig);
    await expect(access(orphan)).rejects.toMatchObject({ code: "ENOENT" });

    const target = join(root, "temp-target");
    await writeFile(target, "preserve", { mode: 0o600 });
    await symlink(target, orphan);
    const result = await runEither(makeBrowserProfileService(root).readConfig);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    expect(await readFile(target, "utf8")).toBe("preserve");
  });

  it("serializes concurrent creates without lost updates or shared temp files", async () => {
    const registry = await service();
    await run(registry.initialize);
    const ids = Array.from({ length: 20 }, (_, index) => `lab-${index}`);

    const results = await Promise.allSettled(ids.map((id) => run(registry.createProfile(id))));

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const list = await run(registry.listProfiles);
    expect(list.map((profile) => profile.id)).toEqual(["personal", "work", ...ids]);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).profiles).toHaveLength(22);
  });

  it("serializes a duplicate create so exactly one caller wins", async () => {
    const registry = await service();
    await run(registry.initialize);

    const results = await Promise.all([
      runEither(registry.createProfile("lab")),
      runEither(registry.createProfile("lab")),
    ]);

    expect(results.filter(Either.isRight)).toHaveLength(1);
    expect(results.filter(Either.isLeft)).toHaveLength(1);
    expect((await run(registry.listProfiles)).filter((profile) => profile.id === "lab")).toHaveLength(1);
  });

  it("durably journals exact paths before lifecycle execution and finalizes default refs afterward", async () => {
    let marker: Record<string, unknown> | undefined;
    const registry = await service(
      lifecycle(async () => {
        marker = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
        return { status: "complete" };
      }),
    );
    await run(registry.initialize);
    const path = join(root, "config.json");
    const seeded = JSON.parse(await readFile(path, "utf8"));
    seeded.canvasDefaults = { portfolio: "personal", workbench: "work" };
    await writeFile(path, `${JSON.stringify(seeded, null, 2)}\n`);

    const receipt = await run(registry.wipeProfile("personal"));

    expect(receipt).toEqual({ status: "complete" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(marker).toMatchObject({
      phase: "wipe_pending",
      defaultProfile: "personal",
      canvasDefaults: { portfolio: "personal", workbench: "work" },
      pendingWipe: {
        profileId: "personal",
        partition: "persist:vellum-profile-personal",
        stage: "live_clear_pending",
        ...wipePaths(root, "personal"),
      },
    });
    expect(marker?.pendingWipe).toMatchObject({
      wipeId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    const final = JSON.parse(await readFile(path, "utf8"));
    expect(final).toMatchObject({
      phase: "ready",
      defaultProfile: "work",
      canvasDefaults: { workbench: "work" },
    });
    expect(final.profiles.map((profile: { id: string }) => profile.id)).toEqual(["work"]);
    await expect(access(join(root, "profiles", "personal"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps durable refs on failure while filtering only the pending target operationally", async () => {
    const failing = await service(lifecycle(async () => { throw new Error("private path"); }));
    await run(failing.initialize);
    const path = join(root, "config.json");
    const seeded = JSON.parse(await readFile(path, "utf8"));
    seeded.canvasDefaults = { portfolio: "personal", workbench: "work" };
    await writeFile(path, `${JSON.stringify(seeded, null, 2)}\n`);

    const wipe = await runEither(failing.wipeProfile("personal"));
    expect(Either.isLeft(wipe)).toBe(true);
    if (Either.isLeft(wipe)) {
      expect(wipe.left.code).toBe("pending_wipe");
      expect(wipe.left.message).not.toContain(root);
    }
    expect((await run(failing.listProfiles)).map((profile) => profile.id)).toEqual(["work"]);
    expect(await run(failing.partitionName("work"))).toBe("persist:vellum-profile-work");
    const targetPartition = await runEither(failing.partitionName("personal"));
    expect(Either.isLeft(targetPartition)).toBe(true);
    expect(await run(failing.resolveDefaultProfile("portfolio"))).toBe("work");
    await run(failing.touchProfile("work"));

    const pending = JSON.parse(await readFile(path, "utf8"));
    expect(pending).toMatchObject({
      phase: "wipe_pending",
      defaultProfile: "personal",
      canvasDefaults: { portfolio: "personal", workbench: "work" },
      pendingWipe: { profileId: "personal" },
    });

    let liveCalls = 0;
    let coldPending: BrowserProfilePendingWipe | undefined;
    const recovered = makeBrowserProfileService(root, {
      wipeLifecycle: lifecycle(
        async () => {
          liveCalls += 1;
          return { status: "complete" };
        },
        async (pendingWipe) => {
          coldPending = pendingWipe;
        },
      ),
      now: () => new Date(FIXED_TIME),
    });
    await run(recovered.recoverPendingWipe);
    expect((await run(recovered.initialize)).profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect(liveCalls).toBe(0);
    expect(coldPending).toMatchObject({
      profileId: "personal",
      stage: "live_clear_pending",
      partition: "persist:vellum-profile-personal",
    });
    expect(JSON.parse(await readFile(path, "utf8")).phase).toBe("ready");
  });

  it("returns restart_required, persists restart deletion, and cold-recovers without live execution", async () => {
    let liveProcessColdCalls = 0;
    const registry = await service(
      lifecycle(
        async () => ({ status: "restart_delete_pending" }),
        async () => {
          liveProcessColdCalls += 1;
        },
      ),
    );
    await run(registry.initialize);

    const receipt = await run(registry.wipeProfile("personal"));
    expect(receipt).toEqual({ status: "restart_required" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8"))).toMatchObject({
      phase: "wipe_pending",
      pendingWipe: { profileId: "personal", stage: "restart_delete_pending" },
    });
    expect((await run(registry.readConfig)).profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect((await run(registry.initialize)).profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect((await run(registry.ensureDefaults)).profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect(liveProcessColdCalls).toBe(0);
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).phase).toBe(
      "wipe_pending",
    );
    expect(await run(registry.partitionName("work"))).toBe("persist:vellum-profile-work");

    let liveCalls = 0;
    let recoveredStage = "";
    const recovered = makeBrowserProfileService(root, {
      wipeLifecycle: lifecycle(
        async () => {
          liveCalls += 1;
          return { status: "complete" };
        },
        async (pending) => {
          recoveredStage = pending.stage;
        },
      ),
      now: () => new Date(FIXED_TIME),
    });
    await run(recovered.recoverPendingWipe);
    expect((await run(recovered.initialize)).profiles.map((profile) => profile.id)).toEqual(["work"]);
    expect(liveCalls).toBe(0);
    expect(recoveredStage).toBe("restart_delete_pending");
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).phase).toBe("ready");
  });

  it.each([
    [
      "non-v4 wipe id",
      (pending: Record<string, unknown>) => {
        pending.wipeId = "00000000-0000-0000-0000-000000000000";
      },
    ],
    [
      "mismatched partition",
      (pending: Record<string, unknown>) => {
        pending.partition = "persist:vellum-profile-work";
      },
    ],
    [
      "legacy ambiguous stage",
      (pending: Record<string, unknown>) => {
        pending.stage = "delete_pending";
      },
    ],
    [
      "session path outside user data",
      (pending: Record<string, unknown>) => {
        pending.sessionDataPath = join(root, "outside-session");
      },
    ],
    [
      "storage path equal to a root",
      (pending: Record<string, unknown>) => {
        pending.storagePath = pending.sessionDataPath;
      },
    ],
  ])("strictly rejects a pending record with %s", async (_name, mutate) => {
    const registry = await service(lifecycle(async () => { throw new Error("live clear failed"); }));
    await run(registry.initialize);
    await runEither(registry.wipeProfile("personal"));
    const path = join(root, "config.json");
    const disk = JSON.parse(await readFile(path, "utf8")) as {
      pendingWipe: Record<string, unknown>;
    };
    mutate(disk.pendingWipe);
    const tampered = `${JSON.stringify(disk, null, 2)}\n`;
    await writeFile(path, tampered, { mode: 0o600 });

    const result = await runEither(makeBrowserProfileService(root).readConfig);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    expect(await readFile(path, "utf8")).toBe(tampered);
  });

  it("refuses a wipe without lifecycle or when it would remove the last profile", async () => {
    const registry = await service();
    await run(registry.initialize);
    const before = await readFile(join(root, "config.json"), "utf8");
    const unavailable = await runEither(registry.wipeProfile("work"));
    expect(Either.isLeft(unavailable)).toBe(true);
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);

    const only = {
      version: 1,
      phase: "ready",
      ...legacyConfig(),
      canvasDefaults: {},
      profiles: [{ id: "personal", createdAt: FIXED_TIME }],
    };
    await writeFile(join(root, "config.json"), `${JSON.stringify(only, null, 2)}\n`);
    let prepared = false;
    const oneProfile = makeBrowserProfileService(root, {
      wipeLifecycle: {
        prepare: async ({ profileId }) => {
          prepared = true;
          return wipePaths(root, profileId);
        },
        executeLive: async () => ({ status: "complete" }),
        recoverCold: async () => undefined,
      },
    });
    const last = await runEither(oneProfile.wipeProfile("personal"));
    expect(Either.isLeft(last)).toBe(true);
    if (Either.isLeft(last)) expect(last.left.code).toBe("forbidden");
    expect(prepared).toBe(false);
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).phase).toBe("ready");
  });

  it("never recursively deletes an unexpected bookkeeping entry", async () => {
    const registry = await service(lifecycle());
    await run(registry.initialize);
    const sentinel = join(root, "profiles", "personal", "sentinel");
    await writeFile(sentinel, "preserve", { mode: 0o600 });

    const result = await runEither(registry.wipeProfile("personal"));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("corrupt");
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
    expect(JSON.parse(await readFile(join(root, "config.json"), "utf8")).phase).toBe("wipe_pending");
  });

  it.each([
    [
      "storage outside session data",
      (base: ReturnType<typeof wipePaths>) => ({ ...base, storagePath: join(root, "outside") }),
    ],
    [
      "session data outside user data",
      (base: ReturnType<typeof wipePaths>) => ({ ...base, sessionDataPath: join(root, "session") }),
    ],
    [
      "storage equal to user data",
      (base: ReturnType<typeof wipePaths>) => ({ ...base, storagePath: base.userDataPath }),
    ],
    [
      "storage equal to session data",
      (base: ReturnType<typeof wipePaths>) => ({ ...base, storagePath: base.sessionDataPath }),
    ],
  ])("rejects %s before writing a pending marker", async (_name, mutate) => {
    const registry = await service({
      prepare: async ({ profileId }) => mutate(wipePaths(root, profileId)),
      executeLive: async () => ({ status: "complete" }),
      recoverCold: async () => undefined,
    });
    await run(registry.initialize);
    const before = await readFile(join(root, "config.json"), "utf8");

    const result = await runEither(registry.wipeProfile("personal"));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left.code).toBe("forbidden");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(before);
  });

  it("doctor reports bounded state without exposing the registry path", async () => {
    const registry = await service();
    const check = await run(registry.doctor);
    expect(check).toMatchObject({ id: "browser-profiles", status: "ok" });
    expect(check.detail).toContain("registry v1");
    expect(check.detail).not.toContain(root);
  });

  it("keeps hard limit values strict at their exact maxima", async () => {
    await freshRoot();
    await writeFile(
      join(root, "config.json"),
      `${JSON.stringify({
        ...legacyConfig(),
        maxWarmSessions: BROWSER_MAX_WARM_SESSIONS_HARD,
        maxVisibleSurfaces: BROWSER_MAX_VISIBLE_SURFACES_HARD,
      })}\n`,
      { mode: 0o600 },
    );
    const config = await run(makeBrowserProfileService(root).readConfig);
    expect(config.maxWarmSessions).toBe(BROWSER_MAX_WARM_SESSIONS_HARD);
    expect(config.maxVisibleSurfaces).toBe(BROWSER_MAX_VISIBLE_SURFACES_HARD);
  });
});
