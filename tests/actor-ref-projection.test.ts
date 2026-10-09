import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { Command } from "../src/shared/model";
import { InstallationId } from "../src/shared/installation-id";
import { modelSeat } from "../e2e/harness/model";
import { ModelLive } from "../src/main/junto/model/layer";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationFleetTargetRepositoryLive, StationFleetTargetRepository } from "../src/main/junto/station/fleet-target-repository";
import { makeStationRepositoryLive } from "../src/main/junto/station/repository";
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";

it("compiles aliases and host identity from native seats and refuses unresolved placement atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-native-actor-refs-"));
  const installation = Schema.decodeUnknownSync(InstallationId);
  const local = installation("installation-command");
  const remote = installation("installation-remote");
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelLive, ModelDependents.empty),
    Layer.provideMerge(Layer.mergeAll(StationFleetTargetRepositoryLive, makeStationRepositoryLive({ makeInstallationId: () => local })), makeStateEngineLive(join(root, "junto.db"))),
  ));
  const decode = Schema.decodeUnknownSync(Command);
  try {
    const { model, refs, fleet, sql } = await runtime.runPromise(Effect.gen(function* () {
      return { model: yield* ModelService, refs: yield* ModelActorRefs, fleet: yield* StationFleetTargetRepository, sql: yield* SqlClient.SqlClient };
    }));
    await runtime.runPromise(sql.withTransaction(sql`INSERT INTO station_configuration(singleton,role,host_id,agent_host_id,command_center_installation_id,supervised_preferred,configured_at) VALUES (1,'command-center','local',NULL,NULL,0,'2026-07-27T12:00:00.000Z')`));
    await runtime.runPromise(fleet.bind({ hostId: "remote-a", stationInstallationId: remote }));
    const localSeat = modelSeat({ id: "local-agent", key: "local:codex", label: "Local", bindingId: "binding-local" });
    const remoteSeat = modelSeat({ id: "remote-agent", key: "remote-a:codex", label: "Remote", host: "remote-a", bindingId: "binding-remote" });
    for (const [canvas, nodes] of [["alpha", [localSeat, remoteSeat]], ["zeta", [{ ...localSeat, id: "local-alias" }]]] as const) {
      await runtime.runPromise(model.command(decode({ _tag: "CreateCanvas", canvas }), "operator"));
      await runtime.runPromise(model.command(decode({ _tag: "Add", canvas, nodes, wires: [] }), "operator"));
    }
    const alpha = await runtime.runPromise(refs.read("alpha"));
    const all = await runtime.runPromise(refs.read());
    expect(alpha).toEqual([
      { seatId: deriveActorSeatId(local, "binding-local"), canvasName: "alpha", nodeId: "local-agent" },
      { seatId: deriveActorSeatId(remote, "binding-remote"), canvasName: "alpha", nodeId: "remote-agent" },
    ]);
    expect(all).toEqual([...alpha, { seatId: deriveActorSeatId(local, "binding-local"), canvasName: "zeta", nodeId: "local-alias" }]);
    const before = await runtime.runPromise(model.open("alpha"));
    const refused = await runtime.runPromise(Effect.result(model.command(decode({ _tag: "Add", canvas: "alpha", nodes: [modelSeat({ id: "lost-agent", key: "missing-host:codex", label: "Lost", host: "missing-host", bindingId: "binding-lost" })], wires: [] }), "operator")));
    expect(refused).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelRefused", rule: expect.stringContaining("unresolved host") } });
    expect(await runtime.runPromise(model.open("alpha"))).toEqual(before);
    expect(await runtime.runPromise(refs.read())).toEqual(all);
    const nextRemote = installation("installation-remote-next");
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO station_known_installations(installation_id,registered_at) VALUES (${nextRemote},'2026-07-27T12:00:00.000Z')`;
      yield* sql`UPDATE station_fleet_targets SET station_installation_id=${nextRemote} WHERE host_id='remote-a'`;
    })));
    // Host rebinding is independent of canvas seq; references must not cache it.
    expect(await runtime.runPromise(model.open("alpha"))).toEqual(before);
    const rebound = await runtime.runPromise(refs.read("alpha"));
    expect(rebound[0]).toEqual(alpha[0]);
    expect(rebound[1]).toEqual({ ...alpha[1], seatId: deriveActorSeatId(nextRemote, "binding-remote") });
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
