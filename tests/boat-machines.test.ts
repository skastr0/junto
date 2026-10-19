import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { makeBoatClient, type BoatFetch, type BoatRun } from "../src/main/junto/boat/client";
import { boatDir, readBoatRecords, updateBoatRecords, writeBoatMachineSelf } from "../src/main/junto/boat/files";
import { keepBoatMachines } from "../src/main/junto/boat/keeper";
import { startBoatLease } from "../src/main/junto/boat/lease";
import { hostKeyFingerprint, makeBoatMachines } from "../src/main/junto/boat/machines";

const HOST_KEY_A = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIE5/mmasa1p8XO64RQ37Ej9vKxWLMZ2J9hw51Cu8MhpS";
const HOST_KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC9i1Ij7IS8w2mtQvgc0YbEw2TcR0qHdJ5nM8cWbXtQ7";
const MACHINE_KEY = "boat_MACHINEKEY000000000000000000000";
const run: BoatRun = (effect) => Effect.runPromise(effect);

/** One sandbox behind Boat's API: its state moves the way Boat's does. */
const fakeBoat = (initial: string) => {
  const state = { state: initial, hostKey: HOST_KEY_A, port: 40001, archiveAfter: undefined as string | undefined };
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetch: BoatFetch = async (url, init) => {
    const path = new URL(url.toString()).pathname.replace("/api/v1", "");
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method: init.method ?? "GET", path, ...(body === undefined ? {} : { body }) });
    const sandbox = () => ({ id: "bx_test01", state: state.state, ...(state.archiveAfter === undefined ? {} : { archiveAfter: state.archiveAfter }) });
    const ok = (answer: unknown) => new Response(JSON.stringify(answer), { status: 200 });
    if (path.endsWith("/resume")) { state.state = "ready"; state.port += 1; return ok({ ok: true }); }
    if (path.endsWith("/stop")) { state.state = "archived"; return ok({ ok: true }); }
    if (path.endsWith("/sshkey")) return ok({ sshUser: "user", sshEndpoint: `203.0.113.7:${state.port}`, hostKey: state.hostKey });
    if (init.method === "PATCH") { state.archiveAfter = new Date(Date.now() + 1_200_000).toISOString(); return ok({ ok: true, sandbox: sandbox() }); }
    return ok({ ok: true, sandbox: sandbox() });
  };
  return { state, calls, client: makeBoatClient({ key: Effect.succeed("boat_ACCOUNTKEY00000000000000000000"), fetch }), fetch };
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "junto-boat-"));
  await updateBoatRecords(home, (records) => ({ ...records, machines: [{ name: "boat-one", sandboxId: "bx_test01", size: "small" }] }));
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const host: RemoteHost = { id: "boat-one", label: "boat-one", sshEndpoint: "user@198.51.100.1", sshPort: 1 } as RemoteHost;
const setup = (initial: string) => {
  const boat = fakeBoat(initial);
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const hosts = new Map<string, RemoteHost>([[host.id, host]]);
  const connected: string[] = [];
  const machines = makeBoatMachines({
    run, home, client: boat.client, sleep: async () => undefined,
    getHost: async (name) => hosts.get(name),
    upsertHost: async (next) => { hosts.set(next.id, next); },
    connect: async (next) => { connected.push(next.id); },
    disconnect: async () => undefined,
    log: (_level, message, fields) => { logs.push({ message, fields }); },
  });
  return { boat, logs, hosts, connected, machines };
};

it("keeps its files the user's alone: 0700 directories, 0600 files", async () => {
  expect((await stat(boatDir(home))).mode & 0o777).toBe(0o700);
  expect((await stat(join(boatDir(home), "machines.json"))).mode & 0o777).toBe(0o600);
  await writeBoatMachineSelf(home, { version: 1, sandboxId: "bx_test01", keyId: "84d50956-645b-4d4c-9bcc-06e52d01626c" }, MACHINE_KEY);
  expect((await stat(join(boatDir(home), "machine-key"))).mode & 0o777).toBe(0o600);
});

it("refuses to route a sleeping machine and never wakes it to read", async () => {
  const { boat, machines } = setup("archived");
  await expect(machines.route(host)).rejects.toMatchObject({ reason: "asleep" });
  expect(boat.calls.map((call) => call.method)).toEqual(["GET"]);
});

it("routes an awake machine through the forward Boat answered, pinned to its one host key", async () => {
  const { hosts, machines } = setup("ready");
  const routed = await machines.route(host);
  expect(routed).toMatchObject({ sshEndpoint: "user@203.0.113.7", sshPort: 40001, sshHostKeyAlias: "junto-boat.bx-test01" });
  expect(hosts.get("boat-one")).toEqual(routed);
  expect(await readFile(routed.sshKnownHostsFile!, "utf8")).toBe(`junto-boat.bx-test01 ${HOST_KEY_A}\n`);
  expect((await stat(routed.sshKnownHostsFile!)).mode & 0o777).toBe(0o600);
});

it("rewrites the pin, never appends, and logs a changed host key by fingerprint", async () => {
  const { boat, logs, machines } = setup("ready");
  const first = await machines.route(host);
  boat.state.hostKey = HOST_KEY_B;
  await machines.route(host);
  expect(await readFile(first.sshKnownHostsFile!, "utf8")).toBe(`junto-boat.bx-test01 ${HOST_KEY_B}\n`);
  const changed = logs.find((log) => log.message === "Boat machine host key changed");
  expect(changed?.fields).toMatchObject({ sandboxId: "bx_test01", previousHostKey: hostKeyFingerprint(HOST_KEY_A), hostKey: hostKeyFingerprint(HOST_KEY_B) });
  expect(String(changed?.fields.hostKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
});

it("wakes with one lease, then waits for the core to answer a link", async () => {
  const { boat, connected, machines } = setup("archived");
  const [a, b] = await Promise.all([machines.wake("boat-one"), machines.wake("boat-one")]);
  expect(a.power).toBe("awake");
  expect(b).toEqual(a);
  expect(boat.calls.filter((call) => call.path.endsWith("/resume"))).toEqual([{ method: "POST", path: "/sandboxes/bx_test01/resume", body: { ttlSeconds: 1200 } }]);
  expect(connected).toEqual(["boat-one"]);
});

it("passes another machine's route untouched", async () => {
  const { boat, machines } = setup("ready");
  const other = { ...host, id: "studio" } as RemoteHost;
  expect(await machines.route(other)).toBe(other);
  await machines.wakeIfBoat("studio");
  expect(boat.calls).toEqual([]);
});

it("the keeper wakes a sleeping machine once for each new held mail", async () => {
  const { boat, machines } = setup("archived");
  let mail: string | undefined = "01MAIL1";
  const deps = {
    run, home, client: boat.client, machines, log: () => undefined,
    getHost: async () => host, connect: async () => undefined, pendingMail: async () => mail,
  };
  expect(await keepBoatMachines(deps, false)).toEqual([{ name: "boat-one", why: "mail" }]);
  boat.state.state = "archived";
  expect(await keepBoatMachines(deps, false)).toEqual([]);
  mail = "01MAIL2";
  expect(await keepBoatMachines(deps, false)).toEqual([{ name: "boat-one", why: "mail" }]);
  expect((await readBoatRecords(home)).machines[0]!.wokenForMail).toBe("01MAIL2");
});

it("the keeper sets back a deadline someone moved past one lease", async () => {
  const { boat, machines } = setup("ready");
  boat.state.archiveAfter = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const deps = {
    run, home, client: boat.client, machines, log: () => undefined,
    getHost: async () => host, connect: async () => undefined, pendingMail: async () => undefined,
  };
  await keepBoatMachines(deps, false);
  expect(boat.calls.filter((call) => call.method === "PATCH")).toEqual([{ method: "PATCH", path: "/sandboxes/bx_test01", body: { ttlSeconds: 1200 } }]);
  boat.calls.length = 0;
  await keepBoatMachines(deps, false);
  expect(boat.calls.filter((call) => call.method === "PATCH")).toEqual([]);
});

it("the lease renews only while busy, with the machine key", async () => {
  const boat = fakeBoat("ready");
  await writeBoatMachineSelf(home, { version: 1, sandboxId: "bx_test01", keyId: "84d50956-645b-4d4c-9bcc-06e52d01626c" }, MACHINE_KEY);
  const seen: string[] = [];
  const fetch: BoatFetch = (url, init) => { seen.push(new Headers(init.headers).get("authorization") ?? ""); return boat.fetch(url, init); };
  let busy = false;
  const stop = startBoatLease({ run, home, busy: () => busy, log: () => undefined, fetch, first: 1, every: 5 });
  await new Promise((done) => setTimeout(done, 30));
  expect(boat.calls).toEqual([]);
  busy = true;
  await new Promise((done) => setTimeout(done, 30));
  stop();
  expect(boat.calls.length).toBeGreaterThan(0);
  expect(boat.calls.every((call) => call.method === "PATCH" && (call.body as { ttlSeconds: number }).ttlSeconds === 1200)).toBe(true);
  expect(new Set(seen)).toEqual(new Set([`Bearer ${MACHINE_KEY}`]));
});
