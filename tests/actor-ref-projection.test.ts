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
import { deriveActorSeatId } from "../src/main/junto/actor-seat-id";
import { THIS_MACHINE } from "./support/machines";

const at = "2026-07-27T12:00:00.000Z";

it("compiles aliases and machine identity from native seats and refuses unresolved placement atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-native-actor-refs-"));
  const installation = Schema.decodeUnknownSync(InstallationId);
  const local = installation("installation-command");
  const remote = installation("installation-remote");
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelLive, ModelDependents.empty),
    makeStateEngineLive(join(root, "junto.db")),
  ));
  const decode = Schema.decodeUnknownSync(Command);
  try {
    const { model, refs, sql } = await runtime.runPromise(Effect.gen(function* () {
      return { model: yield* ModelService, refs: yield* ModelActorRefs, sql: yield* SqlClient.SqlClient };
    }));
    // This machine and its name, and one other machine it has pinned.
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO known_installations(installation_id,registered_at) VALUES (${local},${at}),(${remote},${at})`;
      yield* sql`INSERT INTO installation(singleton,installation_id,created_at) VALUES (1,${local},${at})`;
      yield* sql`INSERT INTO machine_configuration(singleton,machine_name,supervised_preferred,configured_at) VALUES (1,${THIS_MACHINE},0,${at})`;
      yield* sql`INSERT INTO machine_peers(machine_name,installation_id,bound_at) VALUES ('remote-a',${remote},${at})`;
    })));
    const localSeat = modelSeat({ id: "local-agent", key: "local:codex", label: "Local", host: THIS_MACHINE, bindingId: "binding-local" });
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
    // Where a machine is pinned is read each time, never kept with the canvas:
    // a retired machine's seats stop resolving, and resolve again when it is back.
    await runtime.runPromise(sql.withTransaction(sql`UPDATE machine_peers SET retired_at=${at} WHERE machine_name='remote-a'`));
    expect(await runtime.runPromise(model.open("alpha"))).toEqual(before);
    expect(await runtime.runPromise(Effect.result(refs.read("alpha")))).toMatchObject({ _tag: "Failure" });
    await runtime.runPromise(sql.withTransaction(sql`UPDATE machine_peers SET retired_at=NULL WHERE machine_name='remote-a'`));
    expect(await runtime.runPromise(refs.read("alpha"))).toEqual(alpha);
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
});
