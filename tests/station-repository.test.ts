import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, expect, it } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeSettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { makeStationRepositoryLive, StationRepository } from "../src/main/junto/station/repository";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const databasePath = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-installation-"));
  roots.push(root);
  return join(root, "junto.db");
};

const runtimeFor = (path: string, generated: string) => ManagedRuntime.make(
  Layer.provideMerge(
    Layer.mergeAll(
      makeStationRepositoryLive({
        makeInstallationId: () => Schema.decodeUnknownSync(InstallationId)(generated),
        now: () => "2026-10-09T10:00:00.000Z",
      }),
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
    ),
    makeStateEngineLive(path),
  ),
);

it("reopens with the same installation identity and its known-installation row", async () => {
  const path = await databasePath();
  const first = runtimeFor(path, "machine-first");
  try {
    const repository = await first.runPromise(StationRepository);
    expect(await first.runPromise(repository.installationId)).toBe("machine-first");
    const sql = await first.runPromise(SqlClient.SqlClient);
    expect(await first.runPromise(sql`SELECT installation_id FROM station_known_installations`))
      .toEqual([{ installation_id: "machine-first" }]);
  } finally {
    await first.dispose();
  }
  const reopened = runtimeFor(path, "machine-second");
  try {
    const repository = await reopened.runPromise(StationRepository);
    expect(await reopened.runPromise(repository.installationId)).toBe("machine-first");
  } finally {
    await reopened.dispose();
  }
});

it("reads the configuration written by settings", async () => {
  const runtime = runtimeFor(await databasePath(), "machine-settings");
  try {
    const settings = await runtime.runPromise(SettingsService);
    const repository = await runtime.runPromise(StationRepository);
    await runtime.runPromise(settings.setStationTopology({
      role: "command-center", hostId: "book", supervisedPreferred: true,
    }));
    expect((await runtime.runPromise(repository.configuration))?.configuration).toEqual({
      role: "command-center", hostId: "book", supervisedPreferred: true,
    });
    expect((await runtime.runPromise(settings.get)).station.hostId).toBe("book");
  } finally {
    await runtime.dispose();
  }
});
