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
  ConfigureRequest,
  InstallationId,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationEvent,
  StationEventAck,
  StationHostId,
  type InstallationId as InstallationIdValue,
  type StationEvent as StationEventValue,
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
  StationRepository,
  makeStationRepositoryLive,
  stationEventContentSha256,
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
) =>
  ConfigureRequest.make({
    protocol: STATION_API_PROTOCOL,
    op: "configure",
    installationId: local,
    configuration: {
      role: "command-center",
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

const inboundEvent = (
  home: InstallationIdValue,
  sequence: string,
  body: string,
  originAt: string,
): StationEventValue =>
  StationEvent.make({
    identity: {
      home,
      sequence: decodeSequence(sequence),
    },
    kind: "work.transition",
    body,
    contentSha256: stationEventContentSha256(
      "work.transition",
      body,
    ),
    originAt,
  });

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
        .configure(remoteConfigurationRequest(local, cc))
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
        .configure(remoteConfigurationRequest(local, otherCc))
        .pipe(Effect.either),
    );
    expect(Either.isLeft(wrongConfiguration)).toBe(true);
    if (Either.isLeft(wrongConfiguration)) {
      expect(wrongConfiguration.left._tag).toBe(
        "StationConfigurationError",
      );
    }

    const configured = await runtime.runPromise(
      repository.configure(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T12:02:00.000Z",
      ),
    );
    const configuredRetry = await runtime.runPromise(
      repository.configure(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T19:00:00.000Z",
      ),
    );
    expect(configured.configuration.role).toBe("remote");
    expect(configuredRetry.configuredAt).toBe(configured.configuredAt);

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

  it("installs only verified higher full projections transactionally", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-projection");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);

    const first = await runtime.runPromise(
      repository.installProjection(
        projectRequest(local, "9007199254740993", '{"version":1}'),
        "2026-07-27T12:01:00.000Z",
      ),
    );
    expect(first.decision).toBe("install");

    const idempotent = await runtime.runPromise(
      repository.installProjection(
        projectRequest(local, "9007199254740993", '{"version":1}'),
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
        projectRequest(local, "9007199254740992", '{"stale":true}'),
      ),
    );
    expect(stale.decision).toBe("stale");

    const conflict = await runtime.runPromise(
      repository.installProjection(
        projectRequest(local, "9007199254740993", '{"conflict":true}'),
      ),
    );
    expect(conflict.decision).toBe("conflict");

    const invalid = projectRequest(local, "9007199254740994", "{}");
    const integrityFailure = await runtime.runPromise(
      repository
        .installProjection({
          ...invalid,
          projection: {
            ...invalid.projection,
            body: '{"tampered":true}',
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

    const projection = await runtime.runPromise(repository.projection);
    expect(projection).toMatchObject({
      generation: "9007199254740993",
      body: '{"version":1}',
      receivedAt: "2026-07-27T12:01:00.000Z",
    });
    await runtime.dispose();
  });

  it("serves Settings from the same canonical Command Center configuration", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("command-config-integration");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const settings = await runtime.runPromise(SettingsService);

    const configured = await runtime.runPromise(
      repository.configure(commandCenterConfigurationRequest(local)),
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
      repository.configure(
        remoteConfigurationRequest(local, cc),
        "2026-07-27T13:00:00.000Z",
      ),
    );
    expect(configured.configuration).not.toHaveProperty("browserTrust");

    const trust = pinnedTrust("cc-browser");
    const trustInstalled = await runtime.runPromise(
      repository.configure(
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
      repository.configure(
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
        .configure(
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

  it("deduplicates inbound identities and advances only contiguous cursors", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-events");
    const peer = decodeInstallationId("cc-events");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);

    const second = inboundEvent(
      peer,
      "2",
      '{"state":"second"}',
      "2026-07-27T08:00:00.000Z",
    );
    const first = inboundEvent(
      peer,
      "1",
      '{"state":"first"}',
      "2026-07-27T20:00:00.000Z",
    );
    const gap = await runtime.runPromise(
      repository.acceptInbound(
        [second],
        "2026-07-27T12:01:00.000Z",
      ),
    );
    expect(gap.acknowledge).toEqual([{ home: peer, through: "0" }]);

    const closed = await runtime.runPromise(
      repository.acceptInbound(
        [first],
        "2026-07-27T12:02:00.000Z",
      ),
    );
    expect(closed.acknowledge).toEqual([{ home: peer, through: "2" }]);

    const retry = await runtime.runPromise(
      repository.acceptInbound(
        [{ ...first, originAt: "2026-07-27T23:00:00.000Z" }],
        "2026-07-27T12:03:00.000Z",
      ),
    );
    expect(retry).toMatchObject({ accepted: 0, idempotent: 1 });

    const ordered = await runtime.runPromise(
      repository.eventsAfter(peer, decodeSequence("0")),
    );
    expect(ordered.map((event) => event.identity.sequence)).toEqual([
      "1",
      "2",
    ]);
    expect(ordered[0]?.receivedAt).toBe(
      "2026-07-27T12:02:00.000Z",
    );

    const conflicting = inboundEvent(
      peer,
      "2",
      '{"state":"different"}',
      "2026-07-27T21:00:00.000Z",
    );
    const atomicConflict = await runtime.runPromise(
      repository
        .acceptInbound([
          inboundEvent(
            peer,
            "3",
            '{"state":"third"}',
            "2026-07-27T22:00:00.000Z",
          ),
          conflicting,
        ])
        .pipe(Effect.either),
    );
    expect(Either.isLeft(atomicConflict)).toBe(true);
    if (Either.isLeft(atomicConflict)) {
      expect(atomicConflict.left._tag).toBe(
        "StationEventIdentityConflictError",
      );
    }
    const afterConflict = await runtime.runPromise(
      repository.eventsAfter(peer, decodeSequence("0")),
    );
    expect(afterConflict.map((event) => event.identity.sequence)).toEqual([
      "1",
      "2",
    ]);
    await runtime.dispose();
  });

  it("bounds gap-closing cursor work and advances the remainder on retry", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-cursor-window");
    const peer = decodeInstallationId("cc-cursor-window");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);

    const backlog = Array.from({ length: 256 }, (_, index) => {
      const sequence = String(index + 2);
      return inboundEvent(
        peer,
        sequence,
        `{"sequence":${sequence}}`,
        "2026-07-27T08:00:00.000Z",
      );
    });
    const gap = await runtime.runPromise(
      repository.acceptInbound(backlog),
    );
    expect(gap.acknowledge).toEqual([{ home: peer, through: "0" }]);

    const firstWindow = await runtime.runPromise(
      repository.acceptInbound([
        inboundEvent(
          peer,
          "1",
          '{"sequence":1}',
          "2026-07-27T20:00:00.000Z",
        ),
      ]),
    );
    expect(firstWindow.acknowledge).toEqual([
      { home: peer, through: "256" },
    ]);

    const retryRemainder = await runtime.runPromise(
      repository.acceptInbound([backlog.at(-1)!]),
    );
    expect(retryRemainder).toMatchObject({
      accepted: 0,
      idempotent: 1,
      acknowledge: [{ home: peer, through: "257" }],
    });
    await runtime.dispose();
  });

  it("allocates exact outbound numbers and never regresses peer ACKs", async () => {
    const path = await testDatabase();
    const local = decodeInstallationId("station-outbound");
    const peer = decodeInstallationId("cc-outbound");
    const secondPeer = decodeInstallationId("cc-outbound-b");
    const runtime = makeRuntime(path, local);
    const repository = await runtime.runPromise(StationRepository);
    const state = await runtime.runPromise(StateEngine);

    const one = await runtime.runPromise(
      repository.appendOutbound({
        kind: "work.transition",
        body: '{"step":1}',
        originAt: "2026-07-27T12:00:00.000Z",
      }),
    );
    const two = await runtime.runPromise(
      repository.appendOutbound({
        kind: "work.transition",
        body: '{"step":2}',
        originAt: "2026-07-27T12:00:01.000Z",
      }),
    );
    expect([one.identity.sequence, two.identity.sequence]).toEqual([
      "1",
      "2",
    ]);

    const ackTwo = StationEventAck.make({
      home: local,
      through: decodeSequence("2"),
    });
    const atomicAckFailure = await runtime.runPromise(
      repository
        .advancePeerAcks(peer, [
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
        [ackTwo],
        "2026-07-27T12:01:00.000Z",
      ),
    );
    expect(advanced[0]?._tag).toBe("advanced");

    const regressed = await runtime.runPromise(
      repository.advancePeerAcks(peer, [
        StationEventAck.make({
          home: local,
          through: decodeSequence("1"),
        }),
      ]),
    );
    expect(regressed[0]?._tag).toBe("regression");
    await runtime.runPromise(
      repository.advancePeerAcks(secondPeer, [
        StationEventAck.make({
          home: local,
          through: decodeSequence("1"),
        }),
      ]),
    );

    const impossible = await runtime.runPromise(
      repository
        .advancePeerAcks(peer, [
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

    await runtime.runPromise(
      state.transaction("test.seed-large-sequence", (writer) => {
        writer.run(
          `UPDATE station_outbound_sequences
              SET last_sequence = ?
            WHERE home = ?`,
          ["9007199254740992", local],
        );
      }),
    );
    const exact = await runtime.runPromise(
      repository.appendOutbound({
        kind: "work.transition",
        body: '{"step":"exact"}',
        originAt: "2026-07-27T12:00:02.000Z",
      }),
    );
    expect(exact.identity.sequence).toBe("9007199254740993");
    expect(
      (
        await runtime.runPromise(
          repository.eventsAfter(
            local,
            decodeSequence("9007199254740992"),
          ),
        )
      )[0]?.identity.sequence,
    ).toBe("9007199254740993");

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
