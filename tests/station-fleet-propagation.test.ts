import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  defaultRemoteHostsDocument,
  HostId,
  type RemoteHost,
} from "../src/shared/remote-hosts";
import {
  InstallationId,
  LogicalSequence,
  StationSha256,
} from "../src/shared/station-api";
import {
  StationFleetTargetRepository,
  type StationFleetTarget,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationFleetPropagation,
  StationFleetPropagationLive,
} from "../src/main/vellum/station/fleet-propagation";
import {
  StationPropagation,
  StationPropagationInvariantError,
  type StationPropagationReceipt,
} from "../src/main/vellum/station/propagation";
import { setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";

const hostId = Schema.decodeUnknownSync(HostId);
const installationId = Schema.decodeUnknownSync(InstallationId);
const sequence = Schema.decodeUnknownSync(LogicalSequence);
const sha256 = Schema.decodeUnknownSync(StationSha256);

const target = (
  host: string,
  station: string,
): StationFleetTarget => ({
  hostId: hostId(host),
  stationInstallationId: installationId(station),
  boundAt: "2026-07-27T00:00:00.000Z",
});

const remoteHost = (id: string, sshEndpoint: string): RemoteHost => ({
  id,
  label: id,
  kind: "remote",
  sshEndpoint,
  capabilities: ["terminal"],
});

const receipt = (
  stationInstallationId: ReturnType<typeof installationId>,
): StationPropagationReceipt => ({
  stationInstallationId,
  projection: {
    decision: "unchanged",
    active: {
      generation: sequence("1"),
      contentSha256: sha256("a".repeat(64)),
      receivedAt: "2026-07-27T00:00:00.000Z",
    },
  },
  report: {
    rounds: 1,
    outboundSent: 0,
    inboundReceived: 0,
    inboundAccepted: 0,
    inboundIdempotent: 0,
    acknowledgeInbound: [],
    acknowledgeOutbound: [],
    hasMoreOutbound: false,
    hasMoreInbound: false,
  },
});

describe("StationFleetPropagation", () => {
  it("isolates one unavailable Remote from the rest of the fleet pass", async () => {
    const first = target("studio", "station-studio");
    const second = target("render", "station-render");
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      remoteHost("studio", "studio.example"),
      remoteHost("render", "render.example"),
    ]);
    const targets = StationFleetTargetRepository.of({
      list: Effect.succeed([first, second]),
      bind: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    });
    const propagation = StationPropagation.of({
      synchronize: (input) =>
        input.stationInstallationId === first.stationInstallationId
          ? StationPropagationInvariantError.make({
              operation: "status",
              reason: "database-unavailable",
              message: "offline",
            })
          : Effect.succeed(receipt(input.stationInstallationId)),
    });
    const runtime = ManagedRuntime.make(
      Layer.provide(
        StationFleetPropagationLive,
        Layer.mergeAll(
          Layer.succeed(StationFleetTargetRepository, targets),
          Layer.succeed(StationPropagation, propagation),
        ),
      ),
    );

    try {
      const service = await runtime.runPromise(StationFleetPropagation);
      const results = await runtime.runPromise(service.synchronizeAll);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        ok: false,
        hostId: first.hostId,
      });
      expect(results[1]).toMatchObject({
        ok: true,
        hostId: second.hostId,
      });
    } finally {
      await runtime.dispose();
      setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    }
  });
});
