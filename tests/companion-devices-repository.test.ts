/**
 * The paired-device registry: a pairing device becomes paired exactly once,
 * an expired QR cannot be completed and is swept, last seen is throttled, and
 * Remove (revoke) deletes the device so it can no longer be found.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import {
  COMPANION_LAST_SEEN_RESOLUTION_MS,
  CompanionDeviceRepository,
  CompanionDeviceRepositoryLive,
} from "../src/main/junto/companion/repository";

const A = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const B = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W4";
const PAIRING_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPairingKeyOnlyForTests";
const PHONE_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=";

let root: string;
let runtime: ManagedRuntime.ManagedRuntime<CompanionDeviceRepository, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-companion-devices-"));
  runtime = ManagedRuntime.make(
    CompanionDeviceRepositoryLive.pipe(Layer.provide(makeStateEngineLive(join(root, "junto.db")))),
  );
});

afterEach(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const run = <A, E>(effect: Effect.Effect<A, E, CompanionDeviceRepository>) => runtime.runPromise(effect);
const repo = CompanionDeviceRepository;

describe("CompanionDeviceRepository", () => {
  it("pairs a device once, swapping the one-time key for the phone's", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        const created = yield* r.createPairing({ deviceId: A, pairingPublicKey: PAIRING_KEY, expiresAt: 1_000 + 600_000, now: 1_000 });
        const completed = yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "My iPhone", now: 2_000 });
        const again = yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "My iPhone", now: 3_000 });
        const unknown = yield* r.completePairing({ deviceId: B, publicKey: PHONE_KEY, name: "x", now: 3_000 });
        return { created, completed, again, unknown, listed: yield* r.list() };
      }),
    );
    expect(result.created).toMatchObject({ deviceId: A, state: "pairing", publicKey: PAIRING_KEY, pairingExpiresAt: 601_000 });
    expect(result.completed).toMatchObject({
      ok: true,
      pairingKey: PAIRING_KEY,
      device: { deviceId: A, state: "paired", name: "My iPhone", publicKey: PHONE_KEY, pairedAt: 2_000, lastSeenAt: 2_000 },
    });
    expect(result.completed.ok && result.completed.device).not.toHaveProperty("pairingExpiresAt");
    expect(result.again).toEqual({ ok: false, reason: "already-paired" });
    expect(result.unknown).toEqual({ ok: false, reason: "unknown" });
    expect(result.listed.map((d) => [d.deviceId, d.state])).toEqual([[A, "paired"]]);
  });

  it("refuses an expired pairing and sweeps unused ones", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.createPairing({ deviceId: A, pairingPublicKey: PAIRING_KEY, expiresAt: 10_000, now: 0 });
        yield* r.createPairing({ deviceId: B, pairingPublicKey: PAIRING_KEY, expiresAt: 50_000, now: 0 });
        const late = yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "late", now: 10_000 });
        const swept = yield* r.removeExpired(20_000);
        return { late, swept: swept.map((d) => d.deviceId), left: (yield* r.list()).map((d) => d.deviceId) };
      }),
    );
    expect(result.late).toEqual({ ok: false, reason: "expired" });
    expect(result.swept).toEqual([A]);
    expect(result.left).toEqual([B]);
  });

  it("throttles last seen to its resolution", async () => {
    const seen = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.createPairing({ deviceId: A, pairingPublicKey: PAIRING_KEY, expiresAt: 600_000, now: 0 });
        yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "p", now: 1_000 });
        yield* r.touch(A, 1_000 + COMPANION_LAST_SEEN_RESOLUTION_MS - 1);
        const early = (yield* r.get(A))?.lastSeenAt;
        yield* r.touch(A, 1_000 + COMPANION_LAST_SEEN_RESOLUTION_MS);
        return { early, late: (yield* r.get(A))?.lastSeenAt };
      }),
    );
    expect(seen).toEqual({ early: 1_000, late: 1_000 + COMPANION_LAST_SEEN_RESOLUTION_MS });
  });

  it("revokes: Remove deletes the device, and it is no longer found", async () => {
    const result = await run(
      Effect.gen(function* () {
        const r = yield* repo;
        yield* r.createPairing({ deviceId: A, pairingPublicKey: PAIRING_KEY, expiresAt: 600_000, now: 0 });
        yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "p", now: 1 });
        const removed = yield* r.remove(A);
        return { removed, after: yield* r.get(A), again: yield* r.remove(A), pairAgain: yield* r.completePairing({ deviceId: A, publicKey: PHONE_KEY, name: "p", now: 2 }) };
      }),
    );
    expect(result.removed).toMatchObject({ deviceId: A, publicKey: PHONE_KEY });
    expect(result.after).toBeUndefined();
    expect(result.again).toBeUndefined();
    expect(result.pairAgain).toEqual({ ok: false, reason: "unknown" });
  });
});
