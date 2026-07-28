import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Effect,
  Either,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";
import {
  ConfigureRequest,
  InstallationId,
  LogicalSequence as ProjectionSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/station-api";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import { findHostById } from "../src/main/vellum/hosts/snapshot";
import {
  compileStationPortfolioBody,
  STATION_PORTFOLIO_PROTOCOL,
} from "../src/main/vellum/station/portfolio";
import {
  StationRepository,
  makeStationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  makeStateEngineLive,
  StateEngine,
  type StateRow,
} from "../src/main/vellum/state/engine";

const decodeInstallationId = Schema.decodeUnknownSync(InstallationId);
const decodeProjectionSequence =
  Schema.decodeUnknownSync(ProjectionSequence);
const decodeHostId = Schema.decodeUnknownSync(StationHostId);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

const testDatabase = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "vellum-station-repository-"));
  roots.push(root);
  return join(root, "vellum.db");
};

const makeRuntime = (
  path: string,
  generatedId: InstallationIdValue,
) => {
  const stateLive = makeStateEngineLive(path);
  return ManagedRuntime.make(
    Layer.provideMerge(
      Layer.merge(
        makeStationRepositoryLive({
          makeInstallationId: () => generatedId,
          now: () => "2026-07-27T12:00:00.000Z",
        }),
        SettingsLive,
      ),
      stateLive,
    ),
  );
};

const pairRequest = (
  local: InstallationIdValue,
  commandCenter: InstallationIdValue,
) =>
  PairRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "pair",
    commandCenterInstallationId: commandCenter,
    stationInstallationId: local,
    stationLabel: "Studio Mini",
    appVersion: "0.1.0",
  });

const remoteConfigurationRequest = (
  local: InstallationIdValue,
  commandCenter: InstallationIdValue,
  options: {
    readonly capabilities?: ReadonlyArray<
      "terminal" | "browser" | "herdr" | "hermes"
    >;
    readonly supervisedPreferred?: boolean;
  } = {},
) =>
  ConfigureRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "configure",
    installationId: local,
    configuration: {
      role: "remote",
      hostId: decodeHostId("studio"),
      agentHostId: decodeHostId("studio"),
      commandCenterInstallationId: commandCenter,
      supervisedPreferred: options.supervisedPreferred ?? true,
    },
    host: {
      id: "studio",
      label: "Studio Mini",
      kind: "remote",
      sshEndpoint: "studio",
      capabilities: options.capabilities ?? [
        "terminal",
        "browser",
        "hermes",
      ],
    },
  });

const commandCenterTopology = () => ({
  role: "command-center" as const,
  hostId: "command",
  supervisedPreferred: true,
});

const projectRequest = (
  local: InstallationIdValue,
  generation: string,
  body: string,
) =>
  ProjectRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "project",
    stationInstallationId: local,
    projection: {
      scope: "full",
      generation: decodeProjectionSequence(generation),
      sourceCanvasGeneration: decodeProjectionSequence(generation),
      sourceIntentSha256: stationProjectionContentSha256(
        `source:${body}`,
      ),
      body,
      contentSha256: stationProjectionContentSha256(body),
      createdAt: "2026-07-27T12:00:00.000Z",
    },
  });

const canvasDocument = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text,
    },
  ],
  edges: [],
});

const portfolioBody = (text: string): string =>
  compileStationPortfolioBody(
    new Map([["factory", canvasDocument(text)]]),
    new Map(),
  );

describe("StationRepository", () => {
  it("mints one stable installation identity in the shared database", async () => {
    const path = await testDatabase();
    const firstGenerated = decodeInstallationId("station-first");
    const secondGenerated = decodeInstallationId("station-second");

    const firstRuntime = makeRuntime(path, firstGenerated);
    const first = await firstRuntime.runPromise(
      Effect.gen(function* () {
        const repository = yield* StationRepository;
        return yield* repository.installationId;
      }),
    );
    const firstState = await firstRuntime.runPromise(StateEngine);
    expect(
      await firstRuntime.runPromise(
        firstState.read("test.local-known-installation", (reader) =>
          reader
            .all<StateRow & { readonly installation_id: string }>(
              `SELECT installation_id
                 FROM station_known_installations`,
            )
            .map((row) => row.installation_id)
        ),
      ),
    ).toEqual([firstGenerated]);
    await firstRuntime.dispose();

    const reopenedRuntime = makeRuntime(path, secondGenerated);
    const reopened = await reopenedRuntime.runPromise(
      Effect.gen(function* () {
        const repository = yield* StationRepository;
        return yield* repository.installationId;
      }),
    );
    await reopenedRuntime.dispose();

    expect(first).toBe(firstGenerated);
    expect(reopened).toBe(firstGenerated);
  });

  it("rejects non-Remote repository input before opening a configure transaction", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("remote-only-defense");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);
    const forged = {
      protocol: STATION_API_PROTOCOL,
      op: "configure",
      installationId: local,
      configuration: {
        role: "command-center",
        hostId: decodeHostId("command"),
        supervisedPreferred: true,
      },
    } as unknown as ConfigureRequest;

    const result = await runtime.runPromise(
      repository.configureRemote(forged).pipe(Effect.either),
    );
    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationConfigurationError",
        reason: "remote-only",
      },
    });
    expect(
      await runtime.runPromise(
        state.read("test.remote-only-zero-write", (reader) =>
          Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM station_configuration",
            )?.count ?? -1,
          )
        ),
      ),
    ).toBe(0);
    await runtime.dispose();
  });

  it("rejects a Command Center host registration that does not name the configured Remote", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("host-registration-defense");
    const cc = decodeInstallationId("host-registration-command");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(repository.pair(pairRequest(local, cc)));

    const mismatched = ConfigureRequest.make({
      ...remoteConfigurationRequest(local, cc),
      host: {
        id: "other-studio",
        label: "Other Studio",
        kind: "remote",
        sshEndpoint: "other-studio",
        capabilities: ["browser"],
      },
    });
    const result = await runtime.runPromise(
      repository.configureRemote(mismatched).pipe(Effect.either),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationConfigurationError",
        reason: "host-registration-mismatch",
      },
    });
    expect(
      await runtime.runPromise(
        state.read("test.host-registration-zero-write", (reader) => ({
          configuration: Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM station_configuration",
            )?.count ?? -1,
          ),
          remotes: Number(
            reader.get<StateRow & { readonly count: number }>(
              "SELECT count(*) AS count FROM host_registry WHERE kind = 'remote'",
            )?.count ?? -1,
          ),
        })),
      ),
    ).toEqual({ configuration: 0, remotes: 0 });
    await runtime.dispose();
  });

  it("makes Command Center selection and Remote pairing mutually exclusive", async () => {
    const commandPath = await testDatabase();
    const command = decodeInstallationId("topology-command");
    const peer = decodeInstallationId("topology-peer");
    const commandRuntime = makeRuntime(commandPath, command);
    const commandRepository = await commandRuntime.runPromise(
      StationRepository,
    );
    const commandSettings = await commandRuntime.runPromise(SettingsService);
    await commandRuntime.runPromise(
      commandSettings.setStationTopology(commandCenterTopology()),
    );
    const pairResult = await commandRuntime.runPromise(
      commandRepository.pair(
        pairRequest(command, peer),
      ).pipe(Effect.either),
    );
    expect(pairResult).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "StationPairingTopologyError",
        reason: "command-center-configured",
      },
    });
    expect(
      await commandRuntime.runPromise(commandRepository.pairing),
    ).toBeUndefined();
    expect(
      (await commandRuntime.runPromise(commandRepository.configuration))
        ?.configuration.role,
    ).toBe("command-center");
    await commandRuntime.dispose();

    const remotePath = await testDatabase();
    const remote = decodeInstallationId("topology-remote");
    const remoteRuntime = makeRuntime(remotePath, remote);
    const remoteRepository = await remoteRuntime.runPromise(
      StationRepository,
    );
    const settings = await remoteRuntime.runPromise(SettingsService);
    await remoteRuntime.runPromise(
      remoteRepository.pair(pairRequest(remote, peer)),
    );
    const localPromotion = await remoteRuntime.runPromise(
      settings.setStationTopology({
        role: "command-center",
        hostId: "command",
        supervisedPreferred: true,
      }).pipe(Effect.either),
    );
    expect(localPromotion).toMatchObject({
      _tag: "Left",
      left: {
        code: "validation",
        message: expect.stringContaining("paired installation"),
      },
    });
    expect(
      await remoteRuntime.runPromise(remoteRepository.configuration),
    ).toBeUndefined();
    expect(
      (await remoteRuntime.runPromise(remoteRepository.pairing))
        ?.commandCenterInstallationId,
    ).toBe(peer);
    await remoteRuntime.dispose();
  });

  it("keeps pairing exclusive and makes Remote configuration pairing-bound", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-a");
    const cc = decodeInstallationId("cc-a");
    const otherCc = decodeInstallationId("cc-b");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);

    const invalidTimestamp = await runtime.runPromise(
      repository
        .pair(pairRequest(local, cc), "x".repeat(65))
        .pipe(Effect.either),
    );
    expect(Either.isLeft(invalidTimestamp)).toBe(true);
    if (Either.isLeft(invalidTimestamp)) {
      expect(invalidTimestamp.left).toMatchObject({
        _tag: "StationMetadataError",
        operation: "pair",
        field: "pairedAt",
      });
    }
    expect(await runtime.runPromise(repository.pairing)).toBeUndefined();

    const selfPairing = await runtime.runPromise(
      repository.pair(pairRequest(local, local)).pipe(Effect.either),
    );
    expect(Either.isLeft(selfPairing)).toBe(true);
    if (Either.isLeft(selfPairing)) {
      expect(selfPairing.left).toMatchObject({
        _tag: "StationSelfPairingError",
        installationId: local,
      });
    }

    const unpairedConfiguration = await runtime.runPromise(
      repository
        .configureRemote(remoteConfigurationRequest(local, cc))
        .pipe(Effect.either),
    );
    expect(Either.isLeft(unpairedConfiguration)).toBe(true);
    if (Either.isLeft(unpairedConfiguration)) {
      expect(unpairedConfiguration.left).toMatchObject({
        _tag: "StationConfigurationError",
        reason: "pairing-required",
      });
    }

    const paired = await runtime.runPromise(
      repository.pair(
        pairRequest(local, cc),
        "2026-07-27T12:01:00.000Z",
      ),
    );
    const retry = await runtime.runPromise(
      repository.pair(
        pairRequest(local, cc),
        "2026-07-27T18:00:00.000Z",
      ),
    );
    expect(paired.pairedAt).toBe("2026-07-27T12:01:00.000Z");
    expect(retry.pairedAt).toBe(paired.pairedAt);

    const pairingConflict = await runtime.runPromise(
      repository
        .pair(pairRequest(local, otherCc))
        .pipe(Effect.either),
    );
    expect(Either.isLeft(pairingConflict)).toBe(true);
    if (Either.isLeft(pairingConflict)) {
      expect(pairingConflict.left._tag).toBe(
        "StationPairingConflictError",
      );
    }
    const state = await runtime.runPromise(StateEngine);
    expect(
      await runtime.runPromise(
        state.read("test.paired-known-installations", (reader) =>
          reader
            .all<StateRow & { readonly installation_id: string }>(
              `SELECT installation_id
                 FROM station_known_installations
                ORDER BY installation_id`,
            )
            .map((row) => row.installation_id)
        ),
      ),
    ).toEqual([cc, local]);

    const wrongConfiguration = await runtime.runPromise(
      repository
        .configureRemote(remoteConfigurationRequest(local, otherCc))
        .pipe(Effect.either),
    );
    expect(Either.isLeft(wrongConfiguration)).toBe(true);
    if (Either.isLeft(wrongConfiguration)) {
      expect(wrongConfiguration.left._tag).toBe(
        "StationConfigurationError",
      );
    }

    const configured = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T12:02:00.000Z",
      ),
    );
    const configuredRetry = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T19:00:00.000Z",
      ),
    );
    expect(configured.configuration.role).toBe("remote");
    expect(configuredRetry.configuredAt).toBe(configured.configuredAt);

    const rehome = await runtime.runPromise(
      repository.configureRemote(
        ConfigureRequest.make({
          protocol: STATION_API_PROTOCOL,
          op: "configure",
          installationId: local,
          configuration: {
            role: "remote",
            hostId: decodeHostId("other-studio"),
            agentHostId: decodeHostId("other-studio"),
            commandCenterInstallationId: cc,
            supervisedPreferred: true,
          },
          host: {
            id: "other-studio",
            label: "Other Studio",
            kind: "remote",
            sshEndpoint: "other-studio",
            capabilities: ["browser", "hermes"],
          },
        }),
      ).pipe(Effect.either),
    );
    expect(Either.isLeft(rehome)).toBe(true);
    if (Either.isLeft(rehome)) {
      expect(rehome.left).toMatchObject({
        _tag: "StationConfigurationError",
        reason: "host-immutable",
      });
    }
    const retainedConfiguration = await runtime.runPromise(
      repository.configuration,
    );
    expect(retainedConfiguration).toMatchObject({
      configuration: {
        role: "remote",
        hostId: "studio",
        agentHostId: "studio",
      },
      configuredAt: configured.configuredAt,
    });

    const facts = await runtime.runPromise(repository.statusFacts);
    expect(facts).toMatchObject({
      installationId: local,
      pairing: {
        commandCenterInstallationId: cc,
        pairedAt: "2026-07-27T12:01:00.000Z",
      },
      configuration: {
        role: "remote",
        commandCenterInstallationId: cc,
      },
      configuredAt: "2026-07-27T12:02:00.000Z",
    });
    await runtime.dispose();
  });

  it("keeps configured roles immutable in both directions without side effects", async () => {
    const ccPath = await testDatabase();
    const ccLocal = decodeInstallationId("role-immutable-cc");
    const ccPeer = decodeInstallationId("role-immutable-cc-peer");
    const ccRuntime = makeRuntime(ccPath, ccLocal);
    const ccRepository = await ccRuntime.runPromise(StationRepository);
    const ccSettings = await ccRuntime.runPromise(SettingsService);
    await ccRuntime.runPromise(
      ccSettings.setStationTopology({
        role: "command-center",
        hostId: "shared",
        supervisedPreferred: true,
      }),
    );
    const ccConfigured = await ccRuntime.runPromise(
      ccRepository.configuration,
    );
    expect(ccConfigured).toBeDefined();
    const rejectedRemote = await ccRuntime.runPromise(
      ccRepository
        .configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: ccLocal,
            configuration: {
              role: "remote",
              hostId: decodeHostId("shared"),
              agentHostId: decodeHostId("shared"),
              commandCenterInstallationId: ccPeer,
              supervisedPreferred: false,
            },
            host: {
              id: "shared",
              label: "Shared",
              kind: "remote",
              sshEndpoint: "shared",
              capabilities: ["browser", "hermes"],
            },
          }),
          "2026-07-27T12:02:00.000Z",
        )
        .pipe(Effect.either),
    );
    expect(Either.isLeft(rejectedRemote)).toBe(true);
    if (Either.isLeft(rejectedRemote)) {
      expect(rejectedRemote.left).toMatchObject({
        _tag: "StationConfigurationError",
        reason: "role-immutable",
      });
    }
    expect(await ccRuntime.runPromise(ccRepository.configuration))
      .toEqual(ccConfigured);
    await ccRuntime.dispose();

    const remotePath = await testDatabase();
    const remoteLocal = decodeInstallationId("role-immutable-remote");
    const remotePeer = decodeInstallationId("role-immutable-remote-peer");
    const remoteRuntime = makeRuntime(remotePath, remoteLocal);
    const remoteRepository = await remoteRuntime.runPromise(
      StationRepository,
    );
    const remoteSettings = await remoteRuntime.runPromise(SettingsService);
    await remoteRuntime.runPromise(
      remoteRepository.pair(pairRequest(remoteLocal, remotePeer)),
    );
    const remoteConfigured = await remoteRuntime.runPromise(
      remoteRepository.configureRemote(
        remoteConfigurationRequest(remoteLocal, remotePeer),
        "2026-07-27T13:01:00.000Z",
      ),
    );
    const rejectedCommandCenter = await remoteRuntime.runPromise(
      remoteSettings
        .setStationTopology({
          role: "command-center",
          hostId: "studio",
          supervisedPreferred: false,
        })
        .pipe(Effect.either),
    );
    expect(Either.isLeft(rejectedCommandCenter)).toBe(true);
    if (Either.isLeft(rejectedCommandCenter)) {
      expect(rejectedCommandCenter.left).toMatchObject({
        code: "validation",
        message: expect.stringContaining(
          "Remote topology is configured only",
        ),
      });
    }
    expect(await remoteRuntime.runPromise(remoteRepository.configuration))
      .toEqual({
        configuration: remoteConfigured.configuration,
        configuredAt: remoteConfigured.configuredAt,
      });
    expect(
      (await remoteRuntime.runPromise(remoteRepository.configuration))
        ?.configuration,
    ).toMatchObject({
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      commandCenterInstallationId: remotePeer,
    });
    await remoteRuntime.dispose();
  });

  it("installs only verified higher full projections transactionally", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-projection");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);
    const currentBody = portfolioBody("current");

    const first = await runtime.runPromise(
      repository.installProjection(
        projectRequest(local, "9007199254740993", currentBody),
        "2026-07-27T12:01:00.000Z",
      ),
    );
    expect(first.decision).toBe("install");

    const idempotent = await runtime.runPromise(
      repository.installProjection(
        projectRequest(local, "9007199254740993", currentBody),
        "2026-07-27T20:00:00.000Z",
      ),
    );
    expect(idempotent).toMatchObject({
      decision: "idempotent",
      active: {
        generation: "9007199254740993",
        receivedAt: "2026-07-27T12:01:00.000Z",
      },
    });

    const stale = await runtime.runPromise(
      repository.installProjection(
        projectRequest(
          local,
          "9007199254740992",
          portfolioBody("stale"),
        ),
      ),
    );
    expect(stale.decision).toBe("stale");

    const conflict = await runtime.runPromise(
      repository.installProjection(
        projectRequest(
          local,
          "9007199254740993",
          portfolioBody("conflict"),
        ),
      ),
    );
    expect(conflict.decision).toBe("conflict");

    const invalid = projectRequest(
      local,
      "9007199254740994",
      portfolioBody("integrity"),
    );
    const integrityFailure = await runtime.runPromise(
      repository
        .installProjection({
          ...invalid,
          projection: {
            ...invalid.projection,
            body: portfolioBody("tampered"),
          },
        })
        .pipe(Effect.either),
    );
    expect(Either.isLeft(integrityFailure)).toBe(true);
    if (Either.isLeft(integrityFailure)) {
      expect(integrityFailure.left._tag).toBe(
        "StationProjectionIntegrityError",
      );
    }

    await runtime.runPromise(
      state.transaction("test.seed-projection-cursors", (writer) => {
        writer.run(
          `INSERT INTO station_known_installations(
             installation_id,
             registered_at
           ) VALUES
             ('upstream', ?),
             ('peer', ?)`,
          [
            "2026-07-27T12:03:00.000Z",
            "2026-07-27T12:03:00.000Z",
          ],
        );
        writer.run(
          `INSERT INTO station_received_cursors(
             event_home,
             entity_home,
             through_sequence,
             updated_at
           ) VALUES (?, ?, '7', ?)`,
          [
            "upstream",
            local,
            "2026-07-27T12:03:00.000Z",
          ],
        );
        writer.run(
          `INSERT INTO station_peer_ack_cursors(
             peer_installation_id,
             event_home,
             entity_home,
             through_sequence,
             acknowledged_at
           ) VALUES (?, ?, ?, '5', ?)`,
          [
            "peer",
            local,
            local,
            "2026-07-27T12:03:00.000Z",
          ],
        );
      }),
    );
    const factsBeforeRefusal = await runtime.runPromise(
      repository.statusFacts,
    );

    const malformedFailure = await runtime.runPromise(
      repository
        .installProjection(
          projectRequest(
            local,
            "9007199254740994",
            "{\"protocol\":",
          ),
        )
        .pipe(Effect.either),
    );
    expect(Either.isLeft(malformedFailure)).toBe(true);
    if (Either.isLeft(malformedFailure)) {
      expect(malformedFailure.left).toMatchObject({
        _tag: "StationPortfolioError",
        operation: "decode",
      });
    }

    const workCanvas: CanvasDoc = {
      nodes: [
        {
          id: "tasks",
          type: "text",
          x: 0,
          y: 0,
          width: 240,
          height: 100,
          text: "tasks",
          ether: { tasks: { items: [] } },
        },
      ],
      edges: [],
    };
    const workBody = JSON.stringify({
      protocol: STATION_PORTFOLIO_PROTOCOL,
      documents: [
        {
          name: "factory",
          body: serializeCanvas(workCanvas),
        },
      ],
    });
    const retiredWorkFailure = await runtime.runPromise(
      repository
        .installProjection(
          projectRequest(local, "9007199254740994", workBody),
        )
        .pipe(Effect.either),
    );
    expect(Either.isLeft(retiredWorkFailure)).toBe(true);
    if (Either.isLeft(retiredWorkFailure)) {
      expect(retiredWorkFailure.left).toMatchObject({
        _tag: "StationPortfolioError",
        operation: "decode",
      });
    }

    const projection = await runtime.runPromise(repository.projection);
    expect(projection).toMatchObject({
      generation: "9007199254740993",
      body: currentBody,
      receivedAt: "2026-07-27T12:01:00.000Z",
    });
    expect(await runtime.runPromise(repository.statusFacts)).toEqual(
      factsBeforeRefusal,
    );
    await runtime.dispose();
  });

  it("allocates projection-specific generations and reuses an exact archived compile", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("command-projection-archive");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);
    const body = portfolioBody("compiled intent");
    const sourceIntentSha256 =
      stationProjectionContentSha256("authorial intent 4");
    const draft = {
      scope: "full" as const,
      sourceCanvasGeneration: decodeProjectionSequence("4"),
      sourceIntentSha256,
      body,
      createdAt: "2026-07-27T12:00:00.000Z",
    };

    const first = await runtime.runPromise(
      repository.archiveProjection(
        draft,
        "2026-07-27T12:01:00.000Z",
      ),
    );
    const retry = await runtime.runPromise(
      repository.archiveProjection(
        { ...draft, createdAt: "2026-07-27T13:00:00.000Z" },
        "2026-07-27T13:01:00.000Z",
      ),
    );
    const nextSource = await runtime.runPromise(
      repository.archiveProjection(
        {
          ...draft,
          sourceCanvasGeneration: decodeProjectionSequence("5"),
          sourceIntentSha256:
            stationProjectionContentSha256("authorial intent 5"),
        },
        "2026-07-27T14:01:00.000Z",
      ),
    );
    const topologyChange = await runtime.runPromise(
      repository.archiveProjection(
        {
          ...draft,
          sourceCanvasGeneration: decodeProjectionSequence("5"),
          sourceIntentSha256:
            stationProjectionContentSha256("authorial intent 5"),
          body: portfolioBody("compiled intent after fleet change"),
        },
        "2026-07-27T15:01:00.000Z",
      ),
    );

    expect(first).toMatchObject({
      generation: "1",
      sourceCanvasGeneration: "4",
      sourceIntentSha256,
      contentSha256: stationProjectionContentSha256(body),
    });
    expect(retry).toEqual(first);
    expect(nextSource.generation).toBe("2");
    expect(topologyChange.generation).toBe("3");
    expect(
      await runtime.runPromise(
        repository.projectionByReference({
          generation: first.generation,
          contentSha256: first.contentSha256,
        }),
      ),
    ).toMatchObject({
      ...first,
      receivedAt: "2026-07-27T12:01:00.000Z",
    });
    expect(await runtime.runPromise(repository.projection)).toMatchObject(
      topologyChange,
    );

    const durable = await runtime.runPromise(
      state.read("test.projection-archive-history", (reader) => ({
        versions: reader.all<
          StateRow & {
            readonly generation: string;
            readonly source_canvas_generation: string;
          }
        >(
          `SELECT generation, source_canvas_generation
             FROM station_projection_versions
            ORDER BY length(generation), generation`,
        ),
        head: reader.get<
          StateRow & {
            readonly generation: string;
            readonly content_sha256: string;
          }
        >(
          `SELECT generation, content_sha256
             FROM station_projection_head
            WHERE singleton = 1`,
        ),
      })),
    );
    expect(durable.versions).toEqual([
      { generation: "1", source_canvas_generation: "4" },
      { generation: "2", source_canvas_generation: "5" },
      { generation: "3", source_canvas_generation: "5" },
    ]);
    expect(durable.head).toEqual({
      generation: topologyChange.generation,
      content_sha256: topologyChange.contentSha256,
    });
    await runtime.dispose();
  });

  it("retains every installed Remote projection version while advancing one head", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("remote-projection-history");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);
    const firstRequest = projectRequest(
      local,
      "7",
      portfolioBody("first installed intent"),
    );
    const secondRequest = projectRequest(
      local,
      "8",
      portfolioBody("second installed intent"),
    );

    await runtime.runPromise(
      repository.installProjection(
        firstRequest,
        "2026-07-27T12:01:00.000Z",
      ),
    );
    await runtime.runPromise(
      repository.installProjection(
        secondRequest,
        "2026-07-27T12:02:00.000Z",
      ),
    );

    expect(
      await runtime.runPromise(
        repository.projectionByReference({
          generation: firstRequest.projection.generation,
          contentSha256: firstRequest.projection.contentSha256,
        }),
      ),
    ).toMatchObject({
      ...firstRequest.projection,
      receivedAt: "2026-07-27T12:01:00.000Z",
    });
    expect(await runtime.runPromise(repository.projection)).toMatchObject({
      ...secondRequest.projection,
      receivedAt: "2026-07-27T12:02:00.000Z",
    });
    expect(
      await runtime.runPromise(
        state.read("test.remote-projection-history", (reader) =>
          reader.all<{ readonly generation: string }>(
            `SELECT generation
               FROM station_projection_versions
              ORDER BY generation`,
          )
        ),
      ),
    ).toEqual([{ generation: "7" }, { generation: "8" }]);
    await runtime.dispose();
  });

  it("serves Settings from the same canonical Command Center configuration", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("command-config-integration");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const settings = await runtime.runPromise(SettingsService);

    const configured = await runtime.runPromise(
      settings.setStationTopology(commandCenterTopology()),
    );
    expect(configured.station).toEqual({
      role: "command-center",
      hostId: "command",
      supervisedPreferred: true,
    });
    expect(
      (await runtime.runPromise(repository.configuration))?.configuration,
    ).toEqual({
      role: "command-center",
      hostId: "command",
      supervisedPreferred: true,
    });
    expect((await runtime.runPromise(settings.get)).station).toEqual({
      role: "command-center",
      hostId: "command",
      supervisedPreferred: true,
    });
    await runtime.dispose();
  });

  it("commits canonical Remote configuration atomically with host registration", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-config-integration");
    const cc = decodeInstallationId("cc-config-integration");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const settings = await runtime.runPromise(SettingsService);
    const state = await runtime.runPromise(StateEngine);
    await runtime.runPromise(repository.pair(pairRequest(local, cc)));

    const configured = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T13:00:00.000Z",
      ),
    );
    expect(configured.configuration).toEqual({
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      commandCenterInstallationId: cc,
      supervisedPreferred: true,
    });
    expect(configured.host).toEqual({
      id: "studio",
      label: "Studio Mini",
      kind: "remote",
      sshEndpoint: "studio",
      capabilities: ["terminal", "browser", "hermes"],
    });
    expect(findHostById("studio")).toEqual(configured.host);

    const retry = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T15:00:00.000Z",
      ),
    );
    expect(retry.configuredAt).toBe(configured.configuredAt);
    expect(retry.configuration).toEqual(configured.configuration);

    const durable = await runtime.runPromise(
      state.read("test.station-config-integration", (reader) => ({
        configuration: reader.get<
          StateRow & {
            readonly role: string;
            readonly host_id: string;
            readonly agent_host_id: string | null;
            readonly command_center_installation_id: string | null;
            readonly supervised_preferred: number;
          }
        >(
          `SELECT
             role,
             host_id,
             agent_host_id,
             command_center_installation_id,
             supervised_preferred
             FROM station_configuration
            WHERE singleton = 1`,
        ),
        host: reader.get<
          StateRow & {
            readonly id: string;
            readonly label: string;
            readonly kind: string;
            readonly ssh_endpoint: string | null;
            readonly capability_mask: number | null;
            readonly sort_order: number;
          }
        >(
          `SELECT
             id,
             label,
             kind,
             ssh_endpoint,
             capability_mask,
             sort_order
             FROM host_registry
            WHERE id = 'studio'`,
        ),
      })),
    );
    expect(durable.configuration).toMatchObject({
      role: "remote",
      host_id: "studio",
      agent_host_id: "studio",
      command_center_installation_id: cc,
      supervised_preferred: 1,
    });
    expect(durable.host).toEqual({
      id: "studio",
      label: "Studio Mini",
      kind: "remote",
      ssh_endpoint: "studio",
      capability_mask: 11,
      sort_order: 1,
    });
    expect((await runtime.runPromise(settings.get)).station).toEqual({
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      supervisedPreferred: true,
    });
    expect(
      (await runtime.runPromise(repository.statusFacts)).configuration,
    ).toMatchObject({
      role: "remote",
      hostId: "studio",
      commandCenterInstallationId: cc,
    });

    const flipped = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc, {
          supervisedPreferred: false,
        }),
        "2026-07-27T16:00:00.000Z",
      ),
    );
    expect(flipped.configuredAt).toBe("2026-07-27T16:00:00.000Z");
    expect(flipped.configuration).toMatchObject({
      role: "remote",
      supervisedPreferred: false,
    });
    await runtime.dispose();
  });

});
