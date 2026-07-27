import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
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
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationEventAck,
  StationHostId,
  type InstallationId as InstallationIdValue,
} from "../src/shared/station-api";
import {
  StationBrowserPinnedTrustRecord,
  type StationBrowserPinnedTrustRecord as StationBrowserPinnedTrustRecordValue,
} from "../src/shared/station-browser";
import {
  SettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
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
const decodeSequence = Schema.decodeUnknownSync(LogicalSequence);
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
    readonly browserTrust?: StationBrowserPinnedTrustRecordValue;
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
      commandCenterRef: "cc.tailnet",
      supervisedPreferred: options.supervisedPreferred ?? true,
      ...(options.browserTrust === undefined
        ? {}
        : { browserTrust: options.browserTrust }),
    },
  });

const commandCenterConfigurationRequest = (
  local: InstallationIdValue,
) => ({
    installationId: local,
    configuration: {
      role: "command-center" as const,
      hostId: decodeHostId("command"),
      supervisedPreferred: true,
    },
  });

const pinnedTrust = (
  originStationId: string,
  generation = 1,
): StationBrowserPinnedTrustRecordValue => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpki = publicKey.export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return StationBrowserPinnedTrustRecord.make({
    version: 1,
    generation,
    keyId:
      `ed25519-${
        createHash("sha256")
          .update(publicKeySpki)
          .digest("hex")
          .slice(0, 24)
      }`,
    originStationId,
    status: "active",
    publicKeySpki: publicKeySpki.toString("base64"),
    replacesKeyId: null,
    updatedAt: generation,
  });
};

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
      generation: decodeSequence(generation),
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

  it("makes Command Center selection and Remote pairing mutually exclusive", async () => {
    const commandPath = await testDatabase();
    const command = decodeInstallationId("topology-command");
    const peer = decodeInstallationId("topology-peer");
    const commandRuntime = makeRuntime(commandPath, command);
    const commandRepository = await commandRuntime.runPromise(
      StationRepository,
    );
    await commandRuntime.runPromise(
      commandRepository.configureCommandCenter(
        commandCenterConfigurationRequest(command),
      ),
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
            commandCenterRef: "cc.tailnet",
            supervisedPreferred: true,
            browserTrust: pinnedTrust("other-studio"),
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
    expect(
      retainedConfiguration?.configuration.role === "remote"
        ? retainedConfiguration.configuration.browserTrust
        : undefined,
    ).toBeUndefined();

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
    const ccState = await ccRuntime.runPromise(StateEngine);
    const ccConfigured = await ccRuntime.runPromise(
      ccRepository.configureCommandCenter(
        {
          installationId: ccLocal,
          configuration: {
            role: "command-center",
            hostId: decodeHostId("shared"),
            supervisedPreferred: true,
          },
        },
        "2026-07-27T12:01:00.000Z",
      ),
    );
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
              commandCenterRef: "cc.tailnet",
              supervisedPreferred: false,
              browserTrust: pinnedTrust("shared"),
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
      .toEqual({
        configuration: ccConfigured.configuration,
        configuredAt: ccConfigured.configuredAt,
      });
    expect(
      await ccRuntime.runPromise(
        ccState.read("test.role-immutable-no-trust", (reader) =>
          Number(
            reader.get<StateRow & { readonly count: number }>(
              `SELECT count(*) AS count
                 FROM browser_pinned_origin_trust`,
            )?.count ?? 0,
          )
        ),
      ),
    ).toBe(0);
    await ccRuntime.dispose();

    const remotePath = await testDatabase();
    const remoteLocal = decodeInstallationId("role-immutable-remote");
    const remotePeer = decodeInstallationId("role-immutable-remote-peer");
    const remoteRuntime = makeRuntime(remotePath, remoteLocal);
    const remoteRepository = await remoteRuntime.runPromise(
      StationRepository,
    );
    await remoteRuntime.runPromise(
      remoteRepository.pair(pairRequest(remoteLocal, remotePeer)),
    );
    const remoteTrust = pinnedTrust("role-immutable-remote");
    const remoteConfigured = await remoteRuntime.runPromise(
      remoteRepository.configureRemote(
        remoteConfigurationRequest(remoteLocal, remotePeer, {
          browserTrust: remoteTrust,
        }),
        "2026-07-27T13:01:00.000Z",
      ),
    );
    const rejectedCommandCenter = await remoteRuntime.runPromise(
      remoteRepository
        .configureCommandCenter(
          {
            installationId: remoteLocal,
            configuration: {
              role: "command-center",
              hostId: decodeHostId("studio"),
              supervisedPreferred: false,
            },
          },
          "2026-07-27T13:02:00.000Z",
        )
        .pipe(Effect.either),
    );
    expect(Either.isLeft(rejectedCommandCenter)).toBe(true);
    if (Either.isLeft(rejectedCommandCenter)) {
      expect(rejectedCommandCenter.left).toMatchObject({
        _tag: "StationConfigurationError",
        reason: "pairing-present",
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
      browserTrust: remoteTrust,
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
          `INSERT INTO station_received_cursors(
             home,
             through_sequence,
             updated_at
           ) VALUES (?, '7', ?)`,
          ["upstream", "2026-07-27T12:03:00.000Z"],
        );
        writer.run(
          `INSERT INTO station_peer_ack_cursors(
             peer_installation_id,
             home,
             through_sequence,
             acknowledged_at
           ) VALUES (?, ?, '5', ?)`,
          ["peer", local, "2026-07-27T12:03:00.000Z"],
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

  it("serves Settings from the same canonical Command Center configuration", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("command-config-integration");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const settings = await runtime.runPromise(SettingsService);

    const configured = await runtime.runPromise(
      repository.configureCommandCenter(
        commandCenterConfigurationRequest(local),
      ),
    );
    expect(configured.configuration).toEqual({
      role: "command-center",
      hostId: "command",
      supervisedPreferred: true,
    });
    expect((await runtime.runPromise(settings.get)).station).toEqual({
      role: "command-center",
      hostId: "command",
      commandCenterRef: "",
      supervisedPreferred: true,
    });
    await runtime.dispose();
  });

  it("commits browser trust and canonical Remote configuration atomically", async () => {
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
    expect(configured.configuration).not.toHaveProperty("browserTrust");

    const trust = pinnedTrust("cc-browser");
    const trustInstalled = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc, { browserTrust: trust }),
        "2026-07-27T14:00:00.000Z",
      ),
    );
    // Installing trust on an otherwise identical configuration does not
    // rewrite the configuration clock, but the response includes the durable
    // pin installed before the idempotency decision.
    expect(trustInstalled.configuredAt).toBe(configured.configuredAt);
    expect(
      trustInstalled.configuration.role === "remote"
        ? trustInstalled.configuration.browserTrust
        : undefined,
    ).toEqual(trust);

    const retryWithoutPin = await runtime.runPromise(
      repository.configureRemote(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T15:00:00.000Z",
      ),
    );
    expect(
      retryWithoutPin.configuration.role === "remote"
        ? retryWithoutPin.configuration.browserTrust
        : undefined,
    ).toEqual(trust);

    const durable = await runtime.runPromise(
      state.read("test.station-config-integration", (reader) => ({
        configuration: reader.get<
          StateRow & {
            readonly role: string;
            readonly host_id: string;
            readonly agent_host_id: string | null;
            readonly command_center_installation_id: string | null;
            readonly command_center_ref: string | null;
            readonly supervised_preferred: number;
          }
        >(
          `SELECT
             role,
             host_id,
             agent_host_id,
             command_center_installation_id,
             command_center_ref,
             supervised_preferred
             FROM station_configuration
            WHERE singleton = 1`,
        ),
        pins: Number(
          reader.get<StateRow & { readonly count: number }>(
            `SELECT count(*) AS count
               FROM browser_pinned_origin_trust`,
          )?.count ?? 0,
        ),
      })),
    );
    expect(durable.configuration).toMatchObject({
      role: "remote",
      host_id: "studio",
      agent_host_id: "studio",
      command_center_installation_id: cc,
      command_center_ref: "cc.tailnet",
      supervised_preferred: 1,
    });
    expect(durable.pins).toBe(1);
    expect((await runtime.runPromise(settings.get)).station).toEqual({
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      commandCenterRef: "cc.tailnet",
      supervisedPreferred: true,
    });
    expect(
      (await runtime.runPromise(repository.statusFacts)).configuration,
    ).toMatchObject({
      role: "remote",
      browserTrust: trust,
    });

    // A conflicting pin rolls back the proposed configuration change as well
    // as the trust transition.
    const conflictingTrust = pinnedTrust("cc-browser");
    const rejected = await runtime.runPromise(
      repository
        .configureRemote(
          remoteConfigurationRequest(local, cc, {
            browserTrust: conflictingTrust,
            supervisedPreferred: false,
          }),
          "2026-07-27T16:00:00.000Z",
        )
        .pipe(Effect.either),
    );
    expect(Either.isLeft(rejected)).toBe(true);
    if (Either.isLeft(rejected)) {
      expect(rejected.left).toMatchObject({
        _tag: "StationBrowserTrustError",
        code: "conflict",
      });
    }
    const afterRejected = await runtime.runPromise(
      state.read("test.station-config-rollback", (reader) => ({
        pins: Number(
          reader.get<StateRow & { readonly count: number }>(
            `SELECT count(*) AS count
               FROM browser_pinned_origin_trust`,
          )?.count ?? 0,
        ),
        supervisedPreferred: Number(
          reader.get<
            StateRow & { readonly supervised_preferred: number }
          >(
            `SELECT supervised_preferred
               FROM station_configuration
              WHERE singleton = 1`,
          )?.supervised_preferred ?? -1,
        ),
      })),
    );
    expect(afterRejected.pins).toBe(1);
    expect(afterRejected.supervisedPreferred).toBe(1);
    expect(
      (await runtime.runPromise(repository.configuration))?.configuration,
    ).toMatchObject({
      role: "remote",
      supervisedPreferred: true,
      browserTrust: trust,
    });
    await runtime.dispose();
  });

  it("advances peer ACKs only for canonical work emitted on that route", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-outbound");
    const peer = decodeInstallationId("cc-outbound");
    const secondPeer = decodeInstallationId("cc-outbound-b");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);

    await runtime.runPromise(
      state.transaction("test.seed-work-route", (writer) => {
        writer.run(
          `
            INSERT INTO work_event_sequences(
              event_home,
              entity_home,
              last_seq
            ) VALUES (?, ?, '2')
          `,
          [local, "studio"],
        );
        for (const sequence of ["1", "2"]) {
          writer.run(
            `
              INSERT INTO work_events(
                event_home,
                seq,
                entity_home,
                canvas_name,
                node_id,
                entity_kind,
                entity_id,
                operation,
                origin_at,
                received_at,
                payload_json,
                content_sha256
              ) VALUES (?, ?, ?, 'factory', 'tasks', 'task', ?, ?, ?, ?, ?, ?)
            `,
            [
              local,
              sequence,
              "studio",
              `task-${sequence}`,
              `task.step-${sequence}`,
              "2026-07-27T12:00:00.000Z",
              "2026-07-27T12:00:00.000Z",
              `{"sequence":"${sequence}"}`,
              sequence.repeat(64),
            ],
          );
        }
      }),
    );

    const ackTwo = StationEventAck.make({
      home: local,
      through: decodeSequence("2"),
    });
    const atomicAckFailure = await runtime.runPromise(
      repository
        .advancePeerAcks(peer, "studio", [
          StationEventAck.make({
            home: local,
            through: decodeSequence("1"),
          }),
          StationEventAck.make({
            home: local,
            through: decodeSequence("3"),
          }),
        ])
        .pipe(Effect.either),
    );
    expect(Either.isLeft(atomicAckFailure)).toBe(true);
    expect(
      (await runtime.runPromise(repository.statusFacts))
        .peerAcknowledgedThrough,
    ).toEqual([]);

    const advanced = await runtime.runPromise(
      repository.advancePeerAcks(
        peer,
        "studio",
        [ackTwo],
        "2026-07-27T12:01:00.000Z",
      ),
    );
    expect(advanced[0]?._tag).toBe("advanced");

    const regressed = await runtime.runPromise(
      repository.advancePeerAcks(peer, "studio", [
        StationEventAck.make({
          home: local,
          through: decodeSequence("1"),
        }),
      ]),
    );
    expect(regressed[0]?._tag).toBe("regression");
    await runtime.runPromise(
      repository.advancePeerAcks(secondPeer, "studio", [
        StationEventAck.make({
          home: local,
          through: decodeSequence("1"),
        }),
      ]),
    );

    const impossible = await runtime.runPromise(
      repository
        .advancePeerAcks(peer, "studio", [
          StationEventAck.make({
            home: local,
            through: decodeSequence("3"),
          }),
        ])
        .pipe(Effect.either),
    );
    expect(Either.isLeft(impossible)).toBe(true);
    if (Either.isLeft(impossible)) {
      expect(impossible.left._tag).toBe("StationCursorError");
    }

    const facts = await runtime.runPromise(repository.statusFacts);
    expect(facts.peerAcknowledgedThrough).toEqual([
      {
        peerInstallationId: peer,
        acknowledgement: { home: local, through: "2" },
      },
      {
        peerInstallationId: secondPeer,
        acknowledgement: { home: local, through: "1" },
      },
    ]);
    await runtime.dispose();
  });
});
