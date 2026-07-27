import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Effect,
  Either,
  ManagedRuntime,
} from "effect";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  listProfileDirs,
  makeBrowserProfileService,
  type BrowserProfilePendingWipe,
  type BrowserProfileWipeLifecycle,
  type BrowserProfileWipeOutcome,
} from "../src/main/vellum/browser/profiles";
import { BrowserProfileGate } from "../src/main/vellum/browser/profile-gate";
import {
  BROWSER_MAX_VISIBLE_SURFACES_HARD,
  BROWSER_MAX_WARM_SESSIONS_HARD,
} from "../src/shared/browser-limits";
import {
  makeStateEngineLive,
} from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";

const FIXED_TIME = "2026-07-17T12:00:00.000Z";
const MODE_MASK = 0o777;

const run = <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => Effect.runPromise(effect);

const runEither = <A, E>(
  effect: Effect.Effect<A, E>,
) => Effect.runPromise(Effect.either(effect));

const wipePaths = (
  root: string,
  profileId: string,
) => ({
  userDataPath: join(root, "electron-user-data"),
  sessionDataPath: join(
    root,
    "electron-user-data",
    "Session Data",
  ),
  storagePath: join(
    root,
    "electron-user-data",
    "Session Data",
    "Partitions",
    profileId,
  ),
});

describe("browser profile registry", () => {
  let root = "";
  let registryRoot = "";
  let runtime:
    | ManagedRuntime.ManagedRuntime<StateEngine, unknown>
    | undefined;
  let state:
    | Context.Tag.Service<typeof StateEngine>
    | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    state = undefined;
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
    root = "";
    registryRoot = "";
  });

  const freshState = async () => {
    root = await mkdtemp(
      join(tmpdir(), "vellum-browser-sqlite-"),
    );
    registryRoot = join(root, "browser");
    runtime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    state = await runtime.runPromise(StateEngine);
    return state;
  };

  const service = async (
    wipeLifecycle?: BrowserProfileWipeLifecycle,
    profileGate?: BrowserProfileGate,
  ) => {
    const stateService = await freshState();
    return makeBrowserProfileService(
      stateService,
      registryRoot,
      {
        ...(wipeLifecycle ? { wipeLifecycle } : {}),
        ...(profileGate ? { profileGate } : {}),
        now: () => new Date(FIXED_TIME),
      },
    );
  };

  const lifecycle = (
    executeLive: (
      pending: BrowserProfilePendingWipe,
    ) => Promise<BrowserProfileWipeOutcome> =
      async () => ({ status: "complete" }),
    recoverCold: (
      pending: BrowserProfilePendingWipe,
    ) => Promise<void> =
      async () => undefined,
  ): BrowserProfileWipeLifecycle => ({
    prepare: async ({ profileId }) =>
      wipePaths(root, profileId),
    executeLive,
    recoverCold,
  });

  const query = <A>(
    operation: string,
    body: Parameters<
      Context.Tag.Service<typeof StateEngine>["read"]
    >[1],
  ): Promise<A> => {
    if (!state) throw new Error("state unavailable");
    return run(state.read(operation, body) as Effect.Effect<A>);
  };

  const mutate = (
    operation: string,
    body: Parameters<
      Context.Tag.Service<typeof StateEngine>["transaction"]
    >[1],
  ): Promise<unknown> => {
    if (!state) throw new Error("state unavailable");
    return run(state.transaction(operation, body));
  };

  const pendingRow = () =>
    query<Record<string, unknown> | undefined>(
      "test.browser-pending",
      (reader) =>
        reader.get(`
          SELECT
            wipe_id AS wipeId,
            profile_id AS profileId,
            partition,
            requested_at AS requestedAt,
            stage,
            storage_path AS storagePath,
            user_data_path AS userDataPath,
            session_data_path AS sessionDataPath
          FROM browser_profile_pending_wipe
          WHERE singleton = 1
        `),
    );

  it("seeds SQLite and owner-only physical profile directories", async () => {
    const registry = await service();
    const config = await run(registry.initialize);

    expect(config.defaultProfile).toBe("personal");
    expect(
      config.profiles.map((profile) => profile.id),
    ).toEqual(["personal", "work"]);
    expect(
      await query("test.browser-profiles", (reader) =>
        reader
          .all<{ readonly id: string }>(`
            SELECT id
            FROM browser_profiles
            ORDER BY sort_order
          `)
          .map((row) => row.id)
      ),
    ).toEqual(["personal", "work"]);
    for (const path of [
      registryRoot,
      join(registryRoot, "profiles"),
      join(registryRoot, "profiles", "personal"),
      join(registryRoot, "profiles", "work"),
    ]) {
      expect((await lstat(path)).mode & MODE_MASK).toBe(
        0o700,
      );
    }
    expect(
      await readdir(registryRoot),
    ).not.toContain("config.json");
    expect(
      (await listProfileDirs(registryRoot)).sort(),
    ).toEqual(["personal", "work"]);
  });

  it("keeps SQLite as the only authority across an engine restart", async () => {
    const registry = await service();
    await run(registry.initialize);
    await run(registry.createProfile("lab", "Lab"));

    await runtime?.dispose();
    runtime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    state = await runtime.runPromise(StateEngine);
    const restarted = makeBrowserProfileService(
      state,
      registryRoot,
    );

    expect(
      (await run(restarted.listProfiles)).map(
        (profile) => profile.id,
      ),
    ).toEqual(["personal", "work", "lab"]);
  });

  it("does not read an adjacent legacy config file", async () => {
    const stateService = await freshState();
    await mkdir(registryRoot, { recursive: true });
    await writeFile(
      join(registryRoot, "config.json"),
      JSON.stringify({
        profiles: [{ id: "forged" }],
      }),
    );

    const config = await run(
      makeBrowserProfileService(
        stateService,
        registryRoot,
      ).initialize,
    );

    expect(
      config.profiles.map((profile) => profile.id),
    ).toEqual(["personal", "work"]);
  });

  it("repairs owner directory modes and rejects a profile symlink", async () => {
    const registry = await service();
    await run(registry.initialize);
    for (const path of [
      registryRoot,
      join(registryRoot, "profiles"),
      join(registryRoot, "profiles", "personal"),
      join(registryRoot, "profiles", "work"),
    ]) {
      await chmod(path, 0o755);
    }

    await run(registry.readState);
    for (const path of [
      registryRoot,
      join(registryRoot, "profiles"),
      join(registryRoot, "profiles", "personal"),
      join(registryRoot, "profiles", "work"),
    ]) {
      expect((await lstat(path)).mode & MODE_MASK).toBe(
        0o700,
      );
    }

    const external = join(root, "external-profile");
    await mkdir(external);
    await writeFile(
      join(external, "sentinel"),
      "preserve",
    );
    await rm(join(registryRoot, "profiles", "work"), {
      recursive: true,
    });
    await symlink(
      external,
      join(registryRoot, "profiles", "work"),
    );

    const result = await runEither(registry.readState);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
    expect(
      await readFile(
        join(external, "sentinel"),
        "utf8",
      ),
    ).toBe("preserve");
  });

  it("rejects semantically corrupt rows without rewriting them", async () => {
    const registry = await service();
    await run(registry.initialize);
    await mutate("test.browser-corrupt", (writer) => {
      writer.run(
        `
          UPDATE browser_profiles
          SET created_at = 'yesterday'
          WHERE id = 'work'
        `,
      );
    });

    const result = await runEither(registry.readState);

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
    expect(
      await query("test.browser-corrupt-read", (reader) =>
        reader.get<{ readonly created_at: string }>(
          `
            SELECT created_at
            FROM browser_profiles
            WHERE id = 'work'
          `,
        )?.created_at
      ),
    ).toBe("yesterday");
  });

  it("serializes concurrent creates without lost rows", async () => {
    const registry = await service();
    await run(registry.initialize);
    const ids = Array.from(
      { length: 20 },
      (_, index) => `lab-${index}`,
    );

    const results = await Promise.allSettled(
      ids.map((id) => run(registry.createProfile(id))),
    );

    expect(
      results.every((result) => result.status === "fulfilled"),
    ).toBe(true);
    const persisted = (
      await run(registry.listProfiles)
    ).map((profile) => profile.id);
    expect(persisted.slice(0, 2)).toEqual([
      "personal",
      "work",
    ]);
    expect(persisted.slice(2).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it("allows exactly one concurrent duplicate create", async () => {
    const registry = await service();
    await run(registry.initialize);

    const results = await Promise.all([
      runEither(registry.createProfile("lab")),
      runEither(registry.createProfile("lab")),
    ]);

    expect(results.filter(Either.isRight)).toHaveLength(1);
    expect(results.filter(Either.isLeft)).toHaveLength(1);
  });

  it("does not create a physical profile for a rejected database write", async () => {
    const registry = await service();
    await run(registry.initialize);
    await mutate("test.browser-fill-profile-capacity", (writer) => {
      for (let index = 2; index < 64; index += 1) {
        writer.run(
          `
            INSERT INTO browser_profiles(
              id,
              label,
              created_at,
              last_used_at,
              sort_order
            )
            VALUES (?, NULL, ?, NULL, ?)
          `,
          [`capacity-${index}`, FIXED_TIME, index],
        );
      }
    });

    const result = await runEither(
      registry.createProfile("overflow"),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("forbidden");
    }
    await expect(
      access(
        join(
          registryRoot,
          "profiles",
          "overflow",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a recreated profile to its gate only after commit", async () => {
    const stateService = await freshState();
    const gate = new BrowserProfileGate();
    let createCommitted = false;
    const observedState: Context.Tag.Service<
      typeof StateEngine
    > = {
      ...stateService,
      transaction: (operation, body) =>
        stateService
          .transaction(operation, body)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (
                  operation ===
                    "browser-profiles.create"
                ) {
                  createCommitted = true;
                }
              })
            ),
          ),
    };
    const registry = makeBrowserProfileService(
      observedState,
      registryRoot,
      {
        wipeLifecycle: lifecycle(),
        profileGate: gate,
        now: () => new Date(FIXED_TIME),
      },
    );
    await run(registry.initialize);
    const block = gate.begin("personal");
    if (!block.ok) throw new Error("gate did not block");
    expect(gate.commitDeleted(block.data)).toBe(true);
    await run(registry.wipeProfile("personal"));

    let durableAtAdmission = false;
    const markCreated = gate.markCreated.bind(gate);
    const markCreatedSpy = vi
      .spyOn(gate, "markCreated")
      .mockImplementation((profile) => {
        durableAtAdmission = createCommitted;
        return markCreated(profile);
      });

    await run(
      registry.createProfile("personal", "Personal"),
    );

    expect(markCreatedSpy).toHaveBeenCalledOnce();
    expect(durableAtAdmission).toBe(true);
    expect(gate.disposition("personal")).toBe("open");
  });

  it("keeps a committed profile when admission fails closed", async () => {
    const gate = new BrowserProfileGate();
    expect(gate.begin("lab")).toMatchObject({ ok: true });
    const registry = await service(undefined, gate);
    await run(registry.initialize);

    const result = await runEither(
      registry.createProfile("lab", "Lab"),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toMatchObject({
        code: "pending_wipe",
        message: "browser profile admission unavailable",
      });
    }
    expect(
      (await run(registry.listProfiles)).map(
        (profile) => profile.id,
      ),
    ).toContain("lab");
  });

  it("commits exact wipe intent before external deletion", async () => {
    let observed:
      | Record<string, unknown>
      | undefined;
    const registry = await service(
      lifecycle(async () => {
        observed = await pendingRow();
        return { status: "complete" };
      }),
    );
    await run(registry.initialize);
    await mutate("test.browser-defaults", (writer) => {
      writer.run(
        `
          INSERT INTO browser_profile_canvas_defaults(
            canvas_name,
            profile_id
          )
          VALUES ('portfolio', 'personal'),
                 ('workbench', 'work')
        `,
      );
    });

    const receipt = await run(
      registry.wipeProfile("personal"),
    );

    expect(receipt).toEqual({ status: "complete" });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(observed).toMatchObject({
      profileId: "personal",
      partition: "persist:vellum-profile-personal",
      stage: "live_clear_pending",
      ...wipePaths(root, "personal"),
    });
    expect(observed?.wipeId).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
    const final = await run(registry.readState);
    expect(final.defaultProfile).toBe("work");
    expect(final.canvasDefaults).toEqual({
      workbench: "work",
    });
    expect(
      final.profiles.map((profile) => profile.id),
    ).toEqual(["work"]);
    expect(await pendingRow()).toBeUndefined();
  });

  it("retains failed intent, filters its target, and cold-recovers", async () => {
    const failing = await service(
      lifecycle(async () => {
        throw new Error("private path");
      }),
    );
    await run(failing.initialize);
    await mutate("test.browser-defaults", (writer) => {
      writer.run(
        `
          INSERT INTO browser_profile_canvas_defaults(
            canvas_name,
            profile_id
          )
          VALUES ('portfolio', 'personal'),
                 ('workbench', 'work')
        `,
      );
    });

    const wipe = await runEither(
      failing.wipeProfile("personal"),
    );
    expect(Either.isLeft(wipe)).toBe(true);
    expect(
      (await run(failing.listProfiles)).map(
        (profile) => profile.id,
      ),
    ).toEqual(["work"]);
    expect(
      await run(
        failing.resolveDefaultProfile("portfolio"),
      ),
    ).toBe("work");
    await run(failing.touchProfile("work"));
    expect(await pendingRow()).toMatchObject({
      profileId: "personal",
      stage: "live_clear_pending",
    });

    let liveCalls = 0;
    let coldPending:
      | BrowserProfilePendingWipe
      | undefined;
    const recovered = makeBrowserProfileService(
      state!,
      registryRoot,
      {
        wipeLifecycle: lifecycle(
          async () => {
            liveCalls += 1;
            return { status: "complete" };
          },
          async (pending) => {
            coldPending = pending;
          },
        ),
      },
    );
    await run(recovered.recoverPendingWipe);
    expect(liveCalls).toBe(0);
    expect(coldPending).toMatchObject({
      profileId: "personal",
      stage: "live_clear_pending",
    });
    expect(await pendingRow()).toBeUndefined();
    expect(
      (await run(recovered.listProfiles)).map(
        (profile) => profile.id,
      ),
    ).toEqual(["work"]);
  });

  it("persists restart recovery and never re-enters live deletion", async () => {
    const registry = await service(
      lifecycle(async () => ({
        status: "restart_delete_pending",
      })),
    );
    await run(registry.initialize);

    expect(
      await run(registry.wipeProfile("personal")),
    ).toEqual({ status: "restart_required" });
    expect(await pendingRow()).toMatchObject({
      profileId: "personal",
      stage: "restart_delete_pending",
    });

    let liveCalls = 0;
    let recoveredStage = "";
    const recovered = makeBrowserProfileService(
      state!,
      registryRoot,
      {
        wipeLifecycle: lifecycle(
          async () => {
            liveCalls += 1;
            return { status: "complete" };
          },
          async (pending) => {
            recoveredStage = pending.stage;
          },
        ),
      },
    );
    await run(recovered.recoverPendingWipe);

    expect(liveCalls).toBe(0);
    expect(recoveredStage).toBe(
      "restart_delete_pending",
    );
    expect(await pendingRow()).toBeUndefined();
  });

  it("rejects corrupt persisted wipe paths without invoking recovery", async () => {
    const failing = await service(
      lifecycle(async () => {
        throw new Error("stay pending");
      }),
    );
    await run(failing.initialize);
    await runEither(failing.wipeProfile("personal"));
    await mutate("test.browser-corrupt-pending", (writer) => {
      writer.run(
        `
          UPDATE browser_profile_pending_wipe
          SET session_data_path = ?
          WHERE singleton = 1
        `,
        [join(root, "outside-session")],
      );
    });
    let recovered = false;
    const serviceAfterRestart = makeBrowserProfileService(
      state!,
      registryRoot,
      {
        wipeLifecycle: lifecycle(
          undefined,
          async () => {
            recovered = true;
          },
        ),
      },
    );

    const result = await runEither(
      serviceAfterRestart.recoverPendingWipe,
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
    expect(recovered).toBe(false);
  });

  it("refuses unavailable or last-profile wipes before preparation", async () => {
    const registry = await service();
    await run(registry.initialize);
    const unavailable = await runEither(
      registry.wipeProfile("work"),
    );
    expect(Either.isLeft(unavailable)).toBe(true);
    expect(await pendingRow()).toBeUndefined();

    await mutate("test.browser-one-profile", (writer) => {
      writer.run(
        `
          UPDATE browser_profile_settings
          SET default_profile = 'personal'
          WHERE singleton = 1
        `,
      );
      writer.run(
        "DELETE FROM browser_profiles WHERE id = 'work'",
      );
    });
    let prepared = false;
    const oneProfile = makeBrowserProfileService(
      state!,
      registryRoot,
      {
        wipeLifecycle: {
          prepare: async ({ profileId }) => {
            prepared = true;
            return wipePaths(root, profileId);
          },
          executeLive: async () => ({
            status: "complete",
          }),
          recoverCold: async () => undefined,
        },
      },
    );

    const last = await runEither(
      oneProfile.wipeProfile("personal"),
    );
    expect(Either.isLeft(last)).toBe(true);
    if (Either.isLeft(last)) {
      expect(last.left.code).toBe("forbidden");
    }
    expect(prepared).toBe(false);
  });

  it("never recursively deletes unexpected physical bookkeeping", async () => {
    const registry = await service(lifecycle());
    await run(registry.initialize);
    const sentinel = join(
      registryRoot,
      "profiles",
      "personal",
      "sentinel",
    );
    await writeFile(sentinel, "preserve", {
      mode: 0o600,
    });

    const result = await runEither(
      registry.wipeProfile("personal"),
    );

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.code).toBe("corrupt");
    }
    expect(await readFile(sentinel, "utf8")).toBe(
      "preserve",
    );
    expect(await pendingRow()).toMatchObject({
      profileId: "personal",
    });
  });

  it.each([
    [
      "storage outside session data",
      (base: ReturnType<typeof wipePaths>) => ({
        ...base,
        storagePath: join(root, "outside"),
      }),
    ],
    [
      "session data outside user data",
      (base: ReturnType<typeof wipePaths>) => ({
        ...base,
        sessionDataPath: join(root, "session"),
      }),
    ],
    [
      "storage equal to user data",
      (base: ReturnType<typeof wipePaths>) => ({
        ...base,
        storagePath: base.userDataPath,
      }),
    ],
    [
      "storage equal to session data",
      (base: ReturnType<typeof wipePaths>) => ({
        ...base,
        storagePath: base.sessionDataPath,
      }),
    ],
  ])(
    "rejects %s before committing a pending wipe",
    async (_name, change) => {
      const registry = await service({
        prepare: async ({ profileId }) =>
          change(wipePaths(root, profileId)),
        executeLive: async () => ({
          status: "complete",
        }),
        recoverCold: async () => undefined,
      });
      await run(registry.initialize);

      const result = await runEither(
        registry.wipeProfile("personal"),
      );

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.code).toBe("forbidden");
      }
      expect(await pendingRow()).toBeUndefined();
    },
  );

  it("reports bounded health without exposing paths", async () => {
    const registry = await service();
    const check = await run(registry.doctor);

    expect(check).toMatchObject({
      id: "browser-profiles",
      status: "ok",
    });
    expect(check.detail).toContain("registry v1");
    expect(check.detail).not.toContain(root);
  });

  it("accepts exact hard-limit maxima from canonical state", async () => {
    const registry = await service();
    await run(registry.initialize);
    await mutate("test.browser-limits", (writer) => {
      writer.run(
        `
          UPDATE browser_profile_settings
          SET
            max_warm_sessions = ?,
            max_visible_surfaces = ?
          WHERE singleton = 1
        `,
        [
          BROWSER_MAX_WARM_SESSIONS_HARD,
          BROWSER_MAX_VISIBLE_SURFACES_HARD,
        ],
      );
    });

    const state = await run(registry.readState);
    expect(state.maxWarmSessions).toBe(
      BROWSER_MAX_WARM_SESSIONS_HARD,
    );
    expect(state.maxVisibleSurfaces).toBe(
      BROWSER_MAX_VISIBLE_SURFACES_HARD,
    );
  });
});
