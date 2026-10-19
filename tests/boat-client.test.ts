import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { BoatApiFailed, makeBoatClient, type BoatFetch } from "../src/main/junto/boat/client";
import { boatPower } from "../src/shared/boat";

const KEY = "boat_TESTKEY0000000000000000000000";
interface Seen { readonly url: string; readonly init: RequestInit }
const fake = (answer: (seen: Seen) => Response) => {
  const seen: Seen[] = [];
  const fetch: BoatFetch = async (url, init) => { const call = { url: url.toString(), init }; seen.push(call); return answer(call); };
  return { seen, client: makeBoatClient({ key: Effect.succeed(KEY), fetch }) };
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);

it("calls Boat's API with the key, and only Boat's origin, refusing redirects", async () => {
  const { seen, client } = fake(() => json(200, { ok: true, sandbox: { id: "bx_abc123", state: "idle", ttlSeconds: 1200, extra: 1 } }));
  const sandbox = await Effect.runPromise(client.sandbox("bx_abc123"));
  expect(sandbox).toEqual({ id: "bx_abc123", state: "idle", ttlSeconds: 1200 });
  expect(seen[0]!.url).toBe("https://boat.dev/api/v1/sandboxes/bx_abc123");
  expect(seen[0]!.init.redirect).toBe("error");
  expect(headerOf(seen[0]!.init, "authorization")).toBe(`Bearer ${KEY}`);
});

it("creates with no stored secrets and snapshots on, unless an environment is named", async () => {
  const { seen, client } = fake(() => json(202, { ok: true, type: "sandbox.created", sandbox: { id: "bx_new001" } }));
  expect(await Effect.runPromise(client.create({ size: "small", ttlSeconds: 1200, idempotencyKey: "k1" }))).toBe("bx_new001");
  expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ type: "small", ttlSeconds: 1200, snapshots: true, noEnv: true });
  expect(headerOf(seen[0]!.init, "idempotency-key")).toBe("k1");
  await Effect.runPromise(client.create({ size: "default", ttlSeconds: 1200, environment: "work", idempotencyKey: "k2" }));
  expect(JSON.parse(String(seen[1]!.init.body))).toEqual({ type: "default", ttlSeconds: 1200, snapshots: true, environment: "work" });
});

it("deletes with Boat's confirmation header naming the same sandbox", async () => {
  const { seen, client } = fake(() => json(202, { ok: true }));
  await Effect.runPromise(client.remove("bx_abc123"));
  expect(seen[0]!.init.method).toBe("DELETE");
  expect(headerOf(seen[0]!.init, "x-ascii-confirm-delete")).toBe("bx_abc123");
});

it("reads the SSH route and refuses a host key that is not one OpenSSH line", async () => {
  const good = { ok: true, sshUser: "user", sshEndpoint: "5.135.139.84:19052", machineIp: "2001:41d0::31", hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH2P" };
  const ok = fake(() => json(200, good));
  expect(await Effect.runPromise(ok.client.installSshKey("bx_abc123", "ssh-ed25519 AAAA junto"))).toMatchObject({ sshUser: "user", sshEndpoint: "5.135.139.84:19052" });
  const bad = fake(() => json(200, { ...good, hostKey: "ssh-ed25519 AAAA\nevil-host ssh-ed25519 BBBB" }));
  const exit = await Effect.runPromiseExit(bad.client.installSshKey("bx_abc123", "ssh-ed25519 AAAA junto"));
  expect(Exit.isFailure(exit)).toBe(true);
});

it("fails in fixed words with Boat's code, and never with the key or the body", async () => {
  const { client } = fake(() => json(403, { ok: false, code: "api_key_sandbox_forbidden", message: `secret ${KEY} echoed` }));
  const exit = await Effect.runPromiseExit(client.stop("bx_other1"));
  expect(Exit.isFailure(exit)).toBe(true);
  const error = Exit.isFailure(exit) ? (exit.cause as unknown as { reasons?: unknown[] }) : undefined;
  const text = JSON.stringify(error) + String(exit);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("echoed");
  const failure = await Effect.runPromise(Effect.flip(client.stop("bx_other1")));
  expect(failure).toBeInstanceOf(BoatApiFailed);
  expect(failure).toMatchObject({ check: "forbidden", code: "api_key_sandbox_forbidden", status: 403 });
});

it("an unreachable Boat is its own failure", async () => {
  const client = makeBoatClient({ key: Effect.succeed(KEY), fetch: async () => { throw new TypeError(`fetch failed ${KEY}`); } });
  const failure = await Effect.runPromise(Effect.flip(client.sandbox("bx_abc123")));
  expect(failure).toMatchObject({ check: "unreachable" });
  expect(failure.message).not.toContain(KEY);
});

it("reads Boat's states into Junto's, and an unknown state is never awake", () => {
  expect(["ready", "idle", "running"].map(boatPower)).toEqual(["awake", "awake", "awake"]);
  expect(boatPower("archived")).toBe("asleep");
  expect(boatPower("archiving")).toBe("falling-asleep");
  expect(boatPower("provisioning")).toBe("waking");
  expect(boatPower("error")).toBe("failed");
  expect(boatPower("something-new")).toBe("failed");
});
