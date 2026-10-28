/**
 * The fleet consensus core under a seeded, faulty world (plan 0.11/06, F1):
 * messages delayed, dropped, duplicated and reordered, machines cut apart,
 * crashed and restarted, data proposed and the list edited at random. The
 * harness checks Raft's four safety properties and ours after every step
 * (tests/support/consensus-sim.ts); a failure names the seed and tick that
 * replay it. Then every fault stops, and the fleet must agree and commit.
 */
import { describe, expect, it } from "vitest";
import { ProposalRefused, type MachineId } from "../src/main/junto/fleet/consensus";
import { Cluster } from "./support/consensus-sim";

const POOL = ["macbook", "mini", "vps", "nuc", "pi"] as const;
const SEEDS = Number(process.env.JUNTO_CONSENSUS_SEEDS ?? 120);
const TICKS = 1_500;

const chaos = (seed: number, first: ReadonlyArray<MachineId>): Cluster => {
  const cluster = new Cluster(seed, POOL, first, { drop: 0.08, duplicate: 0.03, maxDelay: 6 });
  const { rng } = cluster;
  let proposed = 0;
  cluster.run(TICKS, () => {
    if (rng.chance(0.004)) {
      const alive = [...cluster.nodes.keys()];
      if (alive.length > 1) cluster.crash(rng.pick(alive));
    }
    if (cluster.dead.size > 0 && rng.chance(0.02)) cluster.boot(rng.pick([...cluster.dead]));
    if (rng.chance(0.004)) {
      const side = POOL.filter(() => rng.chance(0.5));
      cluster.partition(side, POOL.filter(id => !side.includes(id)));
    }
    if (cluster.cut.size > 0 && rng.chance(0.01)) cluster.heal();
    const leader = cluster.leader();
    if (leader === undefined) return;
    try {
      if (rng.chance(0.15)) {
        leader.propose(`d${proposed++}`);
        cluster.drain(leader.id);
      }
      if (rng.chance(0.003)) {
        // A new ordered list of one to four machines, from the whole pool.
        const list = [...POOL].sort(() => rng.next() - 0.5).slice(0, rng.int(1, 4));
        leader.proposeList(list);
        cluster.drain(leader.id);
      }
      if (rng.chance(0.002)) {
        leader.transfer();
        cluster.drain(leader.id);
      }
    } catch (refused) {
      if (!(refused instanceof ProposalRefused)) throw refused;
    }
  });
  return cluster;
};

/** Every fault stops: the fleet must agree on one list and commit a proposal everywhere it lists. */
const settle = (cluster: Cluster): void => {
  cluster.heal();
  for (const id of [...cluster.dead]) cluster.boot(id);
  cluster.faults = { drop: 0, duplicate: 0, maxDelay: 2 };
  cluster.run(600);
  const entry = cluster.propose("settled", 600);
  expect(entry, `seed ${cluster.seed}: nothing committed once calm`).toBeDefined();
  cluster.run(300);
  const list = cluster.leader()!.members();
  expect(list.old, `seed ${cluster.seed}: still joint`).toBeUndefined();
  for (const id of list.list) {
    expect(cluster.appliedData(id), `seed ${cluster.seed}: ${id} missed the settled entry`).toContain("settled");
  }
  cluster.checkLogs();
  expect(cluster.revoked, `seed ${cluster.seed}: revoked without alone`).toEqual([]);
};

describe("the consensus core under chaos", () => {
  for (const first of [["macbook"], ["macbook", "mini"], ["macbook", "mini", "vps"], [...POOL]] as const) {
    it(`holds every safety property from a list of ${first.length}, over ${SEEDS} seeds`, () => {
      for (let seed = 1; seed <= SEEDS; seed++) settle(chaos(seed * 7_919 + first.length, first));
    }, 300_000);
  }
});
