import { afterEach, expect, it, vi } from "vitest";
import type { InstallationId } from "../src/shared/installation-id";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { LINK_KEEPER_BACKOFF_CAP_MS, makeLinkKeeper, startLinkKeeper, type LinkKeeperDeps } from "../src/main/junto/link/keeper";

const M2 = "01M2INSTALLATION00000000000" as InstallationId;
const M3 = "01M3INSTALLATION00000000000" as InstallationId;
const IDLE = "01IDLEINSTALLATION000000000" as InstallationId;
const BOAT = "01BOATINSTALLATION000000000" as InstallationId;
const hostOf = (id: string) => ({ id, isThisMachine: false }) as RemoteHost;

/** Two machines with a seat on a canvas held here, one sharing nothing, one Boat machine; no link open. */
const rig = () => {
  let clock = 0;
  const open = new Set<InstallationId>();
  const down = new Set<string>();
  const dials: Array<string> = [];
  const logs: Array<string> = [];
  const shares = new Set<InstallationId>([M2, M3, BOAT]);
  const ids = new Map<string, InstallationId>([["m2", M2], ["m3", M3], ["idle", IDLE], ["boat-one", BOAT]]);
  const deps: LinkKeeperDeps = {
    self: "mac",
    peers: async () => [...ids].map(([machineName, installationId]) => ({ machineName, installationId })),
    linked: (peer) => open.has(peer),
    wanted: async (peer) => shares.has(peer.installationId),
    boatMachines: async () => new Set(["boat-one"]),
    getHost: async (name) => hostOf(name),
    connect: async (host) => {
      dials.push(host.id);
      if (down.has(host.id)) throw new Error(`${host.id} is unreachable`);
      open.add(ids.get(host.id)!);
    },
    log: (level, message, fields) => { logs.push(`${level} ${message} ${String(fields.machine)}`); },
    now: () => clock,
  };
  return { deps, open, down, dials, logs, tick: (ms: number) => { clock += ms; } };
};

afterEach(() => { vi.useRealTimers(); });

it("redials a dropped link to a machine with a seat on a held canvas within one pass, with no status read", async () => {
  vi.useFakeTimers();
  const { deps, dials, open } = rig();
  const stop = startLinkKeeper({ ...deps, now: Date.now });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dials.sort()).toEqual(["m2", "m3"]);
  expect(open.has(M2) && open.has(M3)).toBe(true);
  // An open link is left alone.
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dials).toHaveLength(2);
  // The relay is killed: the next pass dials again.
  open.delete(M3);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(dials.filter((name) => name === "m3")).toHaveLength(2);
  stop();
});

it("never dials a machine that shares no canvas, nor wakes a Boat machine", async () => {
  const { deps, dials } = rig();
  const keeper = makeLinkKeeper(deps);
  for (let pass = 0; pass < 5; pass += 1) await keeper.pass();
  expect(dials).not.toContain("idle");
  expect(dials).not.toContain("boat-one");
});

it("backs off a machine that stays unreachable, doubling to the cap, and logs only the changes", async () => {
  const { deps, down, dials, logs, tick, open } = rig();
  down.add("m3");
  const keeper = makeLinkKeeper(deps);
  const dialsOfM3 = () => dials.filter((name) => name === "m3").length;
  const at: Array<number> = [];
  let clock = 0;
  // Two hours of 10 s passes.
  for (; clock <= 2 * 60 * 60_000; clock += 10_000) {
    const before = dialsOfM3();
    await keeper.pass();
    if (dialsOfM3() > before) at.push(clock);
    tick(10_000);
  }
  const gaps = at.slice(1).map((time, index) => time - at[index]!);
  expect(gaps.slice(0, 6)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  expect(gaps.slice(5).every((gap) => gap === LINK_KEEPER_BACKOFF_CAP_MS)).toBe(true);
  expect(at.length).toBeLessThan(30);
  expect(logs).toEqual(["Warning link keeper cannot reach the machine m3"]);
  // It comes back: one log, and the backoff starts over.
  down.delete("m3");
  for (let pass = 0; pass < 31 && !open.has(M3); pass += 1) { await keeper.pass(); tick(10_000); }
  expect(open.has(M3)).toBe(true);
  expect(logs).toEqual(["Warning link keeper cannot reach the machine m3", "Info link keeper reached the machine again m3"]);
  open.delete(M3);
  down.add("m3");
  const before = dialsOfM3();
  await keeper.pass();
  tick(10_000);
  await keeper.pass();
  expect(dialsOfM3() - before).toBe(2);
});
