import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { expect, it } from "vitest";
import { modelFixture, modelNote, modelSeat, modelSeedCommands } from "../e2e/harness/model";
import { createSandbox, destroySandbox, writeFixtureModel, type Sandbox } from "../e2e/harness/sandbox";
import { MachineRepository, MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelDependents } from "../src/main/junto/model/dependents";
import { ModelService } from "../src/main/junto/model/service";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkModelDependentsLive } from "../src/main/junto/work/model-dependents";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

const databaseOf = (sandbox: Sandbox): string =>
  join(sandbox.homeDir, ".junto", "state", "junto.db");

const machineNameIn = (path: string): unknown => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("SELECT machine_name AS name FROM machine_configuration WHERE singleton = 1")
      .get()?.name;
  } finally {
    database.close();
  }
};

const seatHostIn = async (path: string, canvas: string, id: string): Promise<unknown> => {
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    Layer.provide(ModelService.layer, ModelDependents.empty),
    makeStateEngineLive(path),
  ));
  try {
    const opened = await runtime.runPromise(Effect.flatMap(ModelService, (model) => model.open(canvas)));
    const node = opened.nodes.find((candidate) => candidate.id === id);
    return node !== undefined && "host" in node ? node.host : undefined;
  } finally {
    await runtime.dispose();
  }
};

it("names a fresh database's machine and places the fixture's seats on it", async () => {
  const sandbox = await createSandbox();
  try {
    await writeFixtureModel(sandbox, "proof", modelFixture([modelSeat({ id: "a" })]));
    expect(machineNameIn(databaseOf(sandbox))).toBe(THIS_MACHINE);
    expect(await seatHostIn(databaseOf(sandbox), "proof", "a")).toBe(THIS_MACHINE);
  } finally {
    await destroySandbox(sandbox);
  }
});

it("moves the fixture's seats to the name a database was already authored under", async () => {
  const sandbox = await createSandbox();
  try {
    // An app that opened this database first: its machine has a name of its
    // own and a canvas has been authored, so the name can no longer change.
    const runtime = ManagedRuntime.make(Layer.provideMerge(
      Layer.provide(ModelService.layer, WorkModelDependentsLive),
      Layer.provideMerge(
        Layer.mergeAll(WorkRepositoryLive, SettingsLive, MachineRepositoryLive),
        makeStateEngineLive(databaseOf(sandbox)),
      ),
    ));
    try {
      await runtime.runPromise(Effect.gen(function* () {
        yield* (yield* MachineRepository).configureName(OTHER_MACHINE);
        const model = yield* ModelService;
        for (const command of modelSeedCommands("first", modelFixture([modelNote("note", "authored")]))) {
          yield* model.command(command, "operator");
        }
      }));
    } finally {
      await runtime.dispose();
    }

    await writeFixtureModel(sandbox, "proof", modelFixture([modelSeat({ id: "a" })]));
    expect(machineNameIn(databaseOf(sandbox))).toBe(OTHER_MACHINE);
    expect(await seatHostIn(databaseOf(sandbox), "proof", "a")).toBe(OTHER_MACHINE);
  } finally {
    await destroySandbox(sandbox);
  }
});
