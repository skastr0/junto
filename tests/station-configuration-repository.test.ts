import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, test } from "vitest";
import { InstallationId } from "../src/shared/installation-id";
import { StationConfiguration } from "../src/shared/station-api";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { StationConfigurationRepository } from "../src/main/junto/station/configuration-state";
import { KnownInstallations } from "../src/main/junto/station/known-installations";

test("configuration and installation leaves join the owning transaction and preserve remote identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-configuration-sql-"));
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    StationConfigurationRepository.layer,
    KnownInstallations.layer,
  ).pipe(Layer.provideMerge(makeStateEngineLive(join(root, "junto.db")))));
  try {
    await runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const configurations = yield* StationConfigurationRepository;
      const installations = yield* KnownInstallations;
      const home = Schema.decodeUnknownSync(InstallationId)("configuration-home");
      const configuration = Schema.decodeUnknownSync(StationConfiguration)({
        role: "remote", hostId: "studio", agentHostId: "studio-agent",
        commandCenterInstallationId: home, supervisedPreferred: true,
      });
      expect(yield* configurations.read).toBeUndefined();
      const write = Effect.gen(function* () {
        yield* installations.register(home, "first-registration");
        yield* configurations.write(configuration, "first-configuration");
        expect(yield* configurations.read).toEqual({ configuration, configuredAt: "first-configuration" });
      });
      expect(yield* Effect.result(sql.withTransaction(write.pipe(
        Effect.andThen(Effect.fail("rollback")),
      )))).toMatchObject({ _tag: "Failure", failure: "rollback" });
      expect(yield* configurations.read).toBeUndefined();
      expect(yield* sql`SELECT installation_id FROM station_known_installations`).toEqual([]);
      yield* sql.withTransaction(write);
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* installations.register(home, "ignored-registration");
        yield* configurations.write({ ...configuration, supervisedPreferred: false }, "updated-configuration");
      }));
      expect(yield* configurations.read).toEqual({
        configuration: { ...configuration, supervisedPreferred: false }, configuredAt: "updated-configuration",
      });
      expect(yield* sql`SELECT registered_at FROM station_known_installations`).toEqual([{ registered_at: "first-registration" }]);
    }));
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
