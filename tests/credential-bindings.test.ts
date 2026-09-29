import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialBindingRepository } from "../src/main/junto/credentials/bindings";
import { makeStateEngineLive } from "../src/main/junto/state/engine";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<CredentialBindingRepository | SqlClient.SqlClient, unknown>;
const oldId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const openaiId = "33333333-3333-4333-8333-333333333333";
const createdAt = "2026-04-01T10:20:30.000Z";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-credential-bindings-"));
  runtime = ManagedRuntime.make(CredentialBindingRepository.layer.pipe(
    Layer.provideMerge(makeStateEngineLive(join(root, "junto.db"))),
  ));
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

describe("CredentialBindingRepository", () => {
  it("keeps slot routing and retires before activating the replacement", async () => {
    const result = await runtime.runPromise(Effect.gen(function* () {
      const bindings = yield* CredentialBindingRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(Effect.gen(function* () {
        yield* bindings.insert({ credentialId: oldId, slot: "openrouter/apiKey", lifecycle: "active", createdAt });
        yield* bindings.insert({ credentialId: openaiId, slot: "openai/apiKey", lifecycle: "staged", createdAt });
        yield* bindings.setLifecycle(openaiId, "active");
        yield* bindings.setLifecycle(oldId, "delete_pending");
        yield* bindings.insert({ credentialId: nextId, slot: "openrouter/apiKey", lifecycle: "active", createdAt });
      }));
      const all = yield* bindings.list;
      const active = yield* bindings.activeForSlot("openrouter/apiKey");
      yield* sql.withTransaction(bindings.remove(oldId));
      yield* sql.withTransaction(bindings.remove(openaiId));
      return { all, active, remaining: yield* bindings.list };
    }));
    expect(result.all.map((binding) => [binding.credentialId, binding.slot, binding.lifecycle])).toEqual([
      [oldId, "openrouter/apiKey", "delete_pending"],
      [nextId, "openrouter/apiKey", "active"],
      [openaiId, "openai/apiKey", "active"],
    ]);
    expect(result.active?.credentialId).toBe(nextId);
    expect(result.remaining).toEqual([{ credentialId: nextId, slot: "openrouter/apiKey", lifecycle: "active", createdAt }]);
  });

  it("rolls lifecycle changes back with its caller and keeps SQL failures typed", async () => {
    const result = await runtime.runPromise(Effect.gen(function* () {
      const bindings = yield* CredentialBindingRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(bindings.insert({ credentialId: oldId, slot: "openrouter/apiKey", lifecycle: "active", createdAt }));
      const refused = yield* Effect.result(sql.withTransaction(Effect.gen(function* () {
        yield* bindings.setLifecycle(oldId, "delete_pending");
        yield* bindings.insert({ credentialId: nextId, slot: "openai/apiKey", lifecycle: "active", createdAt });
        yield* bindings.insert({ credentialId: openaiId, slot: "openai/apiKey", lifecycle: "active", createdAt });
      })));
      return { refused, all: yield* bindings.list };
    }));
    expect(result.refused).toMatchObject({ _tag: "Failure", failure: { _tag: "CredentialPersistenceError", operation: "insert" } });
    expect(result.all).toEqual([{ credentialId: oldId, slot: "openrouter/apiKey", lifecycle: "active", createdAt }]);
  });
});
