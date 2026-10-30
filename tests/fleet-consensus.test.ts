/**
 * The fleet consensus core (plan 0.11/06, F1): quorums from the operator's
 * ordered list, the pair's casting vote, priority and handover, pre-vote,
 * joint list edits and `alone`. Each case runs the pure core under the
 * deterministic simulation (tests/support/consensus-sim.ts), whose checks of
 * Raft's safety properties run after every step.
 */
import { describe, expect, it } from "vitest";
import { ALONE_TERM_STRIDE, ConsensusNode, isListQuorum, isQuorum, ProposalRefused, type MachineId } from "../src/main/junto/fleet/consensus";
import { Cluster } from "./support/consensus-sim";

const set = (...ids: string[]) => new Set(ids);

describe("quorums from the ordered list", () => {
  it("is the machine itself for one, the fallback for a pair, and a majority past that", () => {
    expect(isListQuorum(["macbook"], set("macbook"))).toBe(true);
    expect(isListQuorum(["macbook", "mini"], set("mini"))).toBe(true);
    expect(isListQuorum(["macbook", "mini"], set("macbook"))).toBe(false);
    expect(isListQuorum(["macbook", "mini", "vps"], set("macbook", "vps"))).toBe(true);
    expect(isListQuorum(["macbook", "mini", "vps"], set("mini"))).toBe(false);
    expect(isListQuorum(["a", "b", "c", "d"], set("a", "b"))).toBe(false);
    expect(isListQuorum([], set("a"))).toBe(false);
  });

  it("needs both lists while joint, and only the sole voter after alone", () => {
    const joint = { list: ["macbook", "mini", "vps"], old: ["macbook", "mini"] };
    expect(isQuorum(joint, set("macbook", "vps"))).toBe(false);
    expect(isQuorum(joint, set("mini"))).toBe(false);
    expect(isQuorum(joint, set("mini", "vps"))).toBe(true);
    expect(isQuorum({ list: ["macbook", "mini"], sole: "macbook" }, set("macbook"))).toBe(true);
    expect(isQuorum({ list: ["macbook", "mini"], sole: "macbook" }, set("mini"))).toBe(false);
  });
});

describe("one machine", () => {
  it("leads after one election timeout and commits on its own", () => {
    const cluster = new Cluster(1, ["macbook"], ["macbook"]);
    expect(cluster.propose("first")).toBeDefined();
    expect(cluster.appliedData("macbook")).toEqual(["first"]);
  });

  it("keeps what it committed across a restart", () => {
    const cluster = new Cluster(2, ["macbook"], ["macbook"]);
    cluster.propose("first");
    cluster.crash("macbook");
    cluster.boot("macbook");
    expect(cluster.propose("second")).toBeDefined();
    expect(cluster.appliedData("macbook")).toEqual(["first", "second"]);
  });
});

describe("a pair", () => {
  it("is led by the first machine while both are up", () => {
    const cluster = new Cluster(3, ["macbook", "mini"], ["macbook", "mini"]);
    cluster.run(200);
    expect(cluster.leader()?.id).toBe("macbook");
    expect(cluster.propose("both up")).toBeDefined();
    cluster.run(20);
    expect(cluster.appliedData("mini")).toEqual(["both up"]);
  });

  it("is ruled by the fallback alone all night, and handed back once the first catches up", () => {
    const cluster = new Cluster(4, ["macbook", "mini"], ["macbook", "mini"]);
    cluster.run(200);
    cluster.crash("macbook");
    cluster.run(200);
    expect(cluster.leader()?.id).toBe("mini");
    for (const night of ["build 1", "build 2", "build 3"]) expect(cluster.propose(night)).toBeDefined();
    cluster.boot("macbook");
    cluster.run(400);
    expect(cluster.leader()?.id).toBe("macbook");
    expect(cluster.appliedData("macbook")).toEqual(["build 1", "build 2", "build 3"]);
    expect(cluster.revoked).toEqual([]);
  });

  it("commits nothing on the first machine alone: cut from the fallback, it stops", () => {
    const cluster = new Cluster(5, ["macbook", "mini"], ["macbook", "mini"]);
    cluster.run(200);
    cluster.partition(["macbook"], ["mini"]);
    const before = cluster.applied.get("macbook")!.length;
    const stale = cluster.node("macbook");
    if (stale.status().role === "leader") stale.propose("lost on macbook");
    cluster.run(300);
    expect(cluster.applied.get("macbook")!.length).toBe(before);
    // The fallback took the authority and commits.
    expect(cluster.leader()?.id).toBe("mini");
    expect(cluster.node("macbook").status().fresh).toBe(false);
    cluster.heal();
    cluster.run(400);
    expect(cluster.appliedData("macbook")).not.toContain("lost on macbook");
  });
});

/**
 * When a machine stands (remote-lead's ruling on 06-fleet-state.md:137): its
 * rank counts the list without the authority it last heard, so the first
 * fallback stands after one timeout and the next after two. No jitter here.
 */
describe("the wait before standing", () => {
  const member = (id: MachineId, list: ReadonlyArray<MachineId>) => new ConsensusNode({
    id, electionTicks: 10, heartbeatTicks: 1, hardState: { term: 1, votedFor: null, commit: 1 },
    log: [{ term: 1, index: 1, payload: { kind: "list", members: { list } } }],
  });
  const hear = (node: ConsensusNode, authority: MachineId) => {
    node.step({ type: "append", from: authority, to: node.id, term: 2, prevIndex: 1, prevTerm: 1, entries: [], commit: 1, at: 0 });
    node.ready();
  };
  /** Ticks until the machine leaves follower: it stood. */
  const standsAfter = (node: ConsensusNode) => {
    for (let tick = 1; tick <= 100; tick++) {
      node.tick();
      node.ready();
      if (node.status().role !== "follower") return tick;
    }
    return undefined;
  };

  it("is one timeout for a pair's fallback once the first machine ruled", () => {
    const mini = member("mini", ["macbook", "mini"]);
    hear(mini, "macbook");
    expect(standsAfter(mini)).toBe(10);
  });

  it("is one timeout for the next machine down a list of three, and two for the one after, when the first ruled", () => {
    for (const [id, wait] of [["mini", 10], ["vps", 20]] as const) {
      const node = member(id, ["macbook", "mini", "vps"]);
      hear(node, "macbook");
      expect(standsAfter(node), id).toBe(wait);
    }
  });

  it("is one timeout for the first machine and two for the third, when the second ruled", () => {
    for (const [id, wait] of [["macbook", 10], ["vps", 20]] as const) {
      const node = member(id, ["macbook", "mini", "vps"]);
      hear(node, "mini");
      expect(standsAfter(node), id).toBe(wait);
    }
  });

  it("counts the whole list when no authority was heard", () => {
    expect(standsAfter(member("vps", ["macbook", "mini", "vps"]))).toBe(30);
  });

  /** Cluster steps per tick: a message can arrive anywhere inside a tick, as on a real link. */
  const STEPS = 8;
  /** At most one machine that is not stalled reports itself fresh: a stalled process answers nothing until its host counts the stall. */
  const oneFresh = (cluster: Cluster, seed: number) => () => {
    const fresh = [...cluster.nodes.values()].filter(node => !cluster.stalls.has(node.id) && node.status().fresh).map(node => node.id);
    expect(fresh.length, `seed ${seed}, tick ${cluster.now}: ${fresh.join(", ")}`).toBeLessThanOrEqual(1);
  };

  it("never has two fresh authorities: the old one's lease lapses before the fallback stands, whatever each clock's rate and phase", () => {
    for (let seed = 30; seed < 90; seed++) {
      const cluster = new Cluster(seed, ["macbook", "mini"], ["macbook", "mini"]);
      // No jitter: every fallback stands the moment its wait ends.
      cluster.jitterTicks = 0;
      cluster.stepsPerTick = STEPS;
      const once = oneFresh(cluster, seed);
      cluster.run(200 * STEPS, once);
      for (let cut = 0; cut < 4; cut++) {
        cluster.partition(["macbook"], ["mini"]);
        cluster.run(cluster.rng.int(15, 60) * STEPS, once);
        cluster.heal();
        cluster.run(cluster.rng.int(15, 60) * STEPS, once);
      }
    }
  }, 120_000);

  it("never has two fresh authorities when the authority stalls past an election timeout and wakes", () => {
    for (const first of [["macbook", "mini"], ["macbook", "mini", "vps"]]) {
      for (let seed = 90; seed < 150; seed++) {
        const cluster = new Cluster(seed, first, first);
        // No jitter: every fallback stands the moment its wait ends.
        cluster.jitterTicks = 0;
        cluster.stepsPerTick = STEPS;
        const once = oneFresh(cluster, seed);
        cluster.run(200 * STEPS, once);
        for (let stall = 0; stall < 6; stall++) {
          const leader = cluster.leader();
          // A blocked event loop or a closed lid: longer than an election timeout, while the others tick on.
          if (leader !== undefined) cluster.stall(leader.id, cluster.rng.int(11 * STEPS, 40 * STEPS));
          cluster.run(cluster.rng.int(20, 120) * STEPS, once);
        }
        cluster.run(300 * STEPS, once);
        expect(cluster.propose("after the stalls"), `seed ${seed}`).toBeDefined();
      }
    }
  }, 120_000);
});

describe("a gap in the authority's clock", () => {
  const pair = () => {
    const macbook = new ConsensusNode({
      id: "macbook", electionTicks: 10, heartbeatTicks: 1, hardState: { term: 1, votedFor: null, commit: 1 },
      log: [{ term: 1, index: 1, payload: { kind: "list", members: { list: ["macbook", "mini"] } } }],
    });
    // A pair's first machine stands after one timeout, and wins on the mini's pre-vote and vote.
    macbook.elapse(10);
    for (let round = 0; round < 2; round++) {
      for (const message of macbook.ready().messages) {
        if (message.type === "pre-vote") macbook.step({ type: "pre-vote-reply", from: "mini", to: "macbook", term: message.term, granted: true });
        if (message.type === "vote") macbook.step({ type: "vote-reply", from: "mini", to: "macbook", term: message.term, granted: true });
      }
    }
    expect(macbook.status().role).toBe("leader");
    return macbook;
  };
  /** The mini answers every append the authority has sent since the last drain. */
  const answer = (macbook: ConsensusNode) => {
    for (const message of macbook.ready().messages) {
      if (message.type === "append") macbook.step({ type: "append-reply", from: "mini", to: "macbook", term: message.term, success: true, index: message.prevIndex + message.entries.length, at: message.at });
    }
  };

  it("ends the lease: answers to appends sent before a gap of more than two ticks do not count, answers to one sent after do", () => {
    const macbook = pair();
    const before = macbook.ready().messages;
    macbook.elapse(1);
    for (const message of before) if (message.type === "append") macbook.step({ type: "append-reply", from: "mini", to: "macbook", term: message.term, success: true, index: message.prevIndex + message.entries.length, at: message.at });
    expect(macbook.status()).toMatchObject({ role: "leader", fresh: true });
    const sentBefore = macbook.ready().messages;
    // Three ticks at once: well inside the lease by the count, but a gap.
    macbook.elapse(3);
    expect(macbook.status().fresh).toBe(false);
    for (const message of sentBefore) if (message.type === "append") macbook.step({ type: "append-reply", from: "mini", to: "macbook", term: message.term, success: true, index: message.prevIndex + message.entries.length, at: message.at });
    expect(macbook.status().fresh).toBe(false);
    answer(macbook);
    expect(macbook.status().fresh).toBe(true);
  });

  it("keeps the lease across two ticks at once, which a late timer gives", () => {
    const macbook = pair();
    answer(macbook);
    expect(macbook.status().fresh).toBe(true);
    macbook.elapse(2);
    expect(macbook.status().fresh).toBe(true);
  });
});

describe("pre-vote", () => {
  it("keeps a machine back from a partition from raising the term", () => {
    const cluster = new Cluster(6, ["a", "b", "c"], ["a", "b", "c"]);
    cluster.run(200);
    const term = cluster.leader()!.status().term;
    cluster.partition(["c"], ["a", "b"]);
    cluster.run(500);
    expect(cluster.node("c").status().term).toBeLessThanOrEqual(term);
    cluster.heal();
    cluster.run(200);
    expect(cluster.leader()!.status().term).toBe(term);
  });
});

describe("a list edit", () => {
  it("adds a machine through a joint entry, then the new list", () => {
    const cluster = new Cluster(7, ["macbook", "mini", "vps"], ["macbook", "mini"]);
    cluster.run(200);
    cluster.node("macbook").proposeList(["macbook", "mini", "vps"]);
    cluster.drain("macbook");
    cluster.run(300);
    for (const id of ["macbook", "mini", "vps"]) expect(cluster.committedList(id)).toEqual({ list: ["macbook", "mini", "vps"] });
    // Now a majority: the first machine and the newcomer commit without the old fallback.
    cluster.crash("mini");
    expect(cluster.propose("without mini")).toBeDefined();
  });

  // remote-lead's case: a pair's quorum is its fallback alone, so a one-step change
  // to a triple gives the old list {mini} and the new list {macbook, vps}, which do
  // not meet. The joint entry needs both, so the cut side cannot commit.
  it("never commits twice when a pair becoming a triple is cut between the two", () => {
    const cluster = new Cluster(8, ["macbook", "mini", "vps"], ["macbook", "mini"]);
    cluster.run(200);
    expect(cluster.leader()?.id).toBe("macbook");
    cluster.partition(["macbook", "vps"], ["mini"]);
    cluster.node("macbook").proposeList(["macbook", "mini", "vps"]);
    cluster.drain("macbook");
    expect(() => cluster.node("macbook").propose("on macbook's side")).not.toThrow();
    cluster.drain("macbook");
    const macbookBefore = cluster.applied.get("macbook")!.length;
    cluster.run(400);
    // The fallback rules on its own vote and commits.
    expect(cluster.leader()?.id).toBe("mini");
    expect(cluster.propose("on mini's side")).toBeDefined();
    // The other side committed nothing: neither the list nor the data.
    expect(cluster.applied.get("macbook")!.length).toBe(macbookBefore);
    // The newcomer holds only what the pair committed before the cut.
    expect(cluster.applied.get("vps")).toEqual(cluster.applied.get("macbook"));
    cluster.heal();
    cluster.run(400);
    cluster.checkLogs();
    for (const id of ["macbook", "mini"]) {
      expect(cluster.appliedData(id)).toEqual(["on mini's side"]);
      expect(cluster.committedList(id)).toEqual({ list: ["macbook", "mini"] });
    }
    expect(cluster.revoked).toEqual([]);
  });

  it("takes one edit at a time", () => {
    const cluster = new Cluster(9, ["a", "b", "c"], ["a", "b"]);
    cluster.run(200);
    const leader = cluster.leader()!;
    cluster.partition([leader.id], ["a", "b", "c"].filter(id => id !== leader.id));
    leader.proposeList(["a", "b", "c"]);
    expect(() => leader.proposeList(["a", "c"])).toThrow(ProposalRefused);
  });

  it("lets a machine the new list drops step down once it commits", () => {
    const cluster = new Cluster(10, ["a", "b", "c"], ["a", "b", "c"]);
    cluster.run(200);
    const leader = cluster.leader()!;
    const rest = ["a", "b", "c"].filter(id => id !== leader.id);
    leader.proposeList(rest);
    cluster.drain(leader.id);
    cluster.run(400);
    expect(cluster.leader()?.id).not.toBe(leader.id);
    expect(rest).toContain(cluster.leader()?.id);
    expect(cluster.propose("after the drop")).toBeDefined();
  });
});

describe("status", () => {
  it("can commit at once on one machine, and on the operator's machine right after alone", () => {
    const one = new Cluster(14, ["macbook"], ["macbook"]);
    one.run(40);
    expect(one.node("macbook").status()).toMatchObject({ role: "leader", fresh: true, canCommit: true });
    const pair = new Cluster(15, ["macbook", "mini"], ["macbook", "mini"]);
    pair.run(200);
    pair.crash("mini");
    pair.run(50);
    expect(pair.node("macbook").status().canCommit).toBe(false);
    pair.node("macbook").alone();
    pair.drain("macbook");
    // No timeout before it can commit: it is the whole quorum.
    expect(pair.node("macbook").status()).toMatchObject({ fresh: true, canCommit: true });
  });

  it("is fresh as soon as a quorum answers a new authority, and not while it hands over", () => {
    const cluster = new Cluster(16, ["a", "b", "c"], ["a", "b", "c"]);
    cluster.run(200);
    const leader = cluster.leader()!;
    expect(leader.status()).toMatchObject({ fresh: true, canCommit: true });
    leader.transfer();
    expect(leader.status()).toMatchObject({ fresh: true, canCommit: false });
  });

  it("names the committed list, and a list not yet committed apart", () => {
    const cluster = new Cluster(17, ["macbook", "mini", "vps"], ["macbook", "mini"]);
    cluster.run(200);
    cluster.partition(["macbook", "vps"], ["mini"]);
    cluster.node("macbook").proposeList(["macbook", "mini", "vps"]);
    expect(cluster.node("macbook").status()).toMatchObject({
      members: { list: ["macbook", "mini"] },
      pendingList: { list: ["macbook", "mini", "vps"], old: ["macbook", "mini"] },
    });
    // Fresh lapses at the first window that heard no quorum of the joint list: at most one election timeout.
    cluster.run(2 * cluster.electionTicks);
    expect(cluster.node("macbook").status().canCommit).toBe(false);
    cluster.heal();
    cluster.run(300);
    const status = cluster.leader()!.status();
    expect(status.pendingList).toBeUndefined();
  });
});

describe("transfer", () => {
  it("hands the authority to a caught-up machine on a clean leave, with no election timeout", () => {
    const cluster = new Cluster(11, ["a", "b", "c"], ["a", "b", "c"]);
    cluster.run(200);
    const leader = cluster.leader()!;
    leader.transfer();
    cluster.drain(leader.id);
    cluster.run(4);
    expect(cluster.leader()?.id).not.toBe(leader.id);
    cluster.crash(leader.id);
    expect(cluster.propose("after the leave", 20)).toBeDefined();
    expect(cluster.revoked).toEqual([]);
  });

  it("takes proposals again when the target never took it", () => {
    const cluster = new Cluster(12, ["a", "b", "c"], ["a", "b", "c"]);
    cluster.run(200);
    const leader = cluster.leader()!;
    const target = ["a", "b", "c"].find(id => id !== leader.id)!;
    leader.transfer(target);
    cluster.drain(leader.id);
    cluster.crash(target);
    expect(() => leader.propose("refused")).toThrow(ProposalRefused);
    cluster.run(40);
    expect(cluster.leader()?.id).toBe(leader.id);
    expect(() => leader.propose("taken")).not.toThrow();
  });
});

describe("alone", () => {
  it("is only for a committed pair this machine is in, and only while it cannot commit", () => {
    const three = new Cluster(18, ["a", "b", "c"], ["a", "b", "c"]);
    three.run(200);
    expect(() => three.node("a").alone()).toThrow(expect.objectContaining({ reason: "not-pair" }));
    const pair = new Cluster(19, ["macbook", "mini", "vps"], ["macbook", "mini"]);
    pair.run(200);
    expect(() => pair.node("vps").alone()).toThrow(expect.objectContaining({ reason: "not-pair" }));
    // The fallback rules on its own vote: it never needs alone.
    pair.crash("macbook");
    pair.run(200);
    expect(() => pair.node("mini").alone()).toThrow(expect.objectContaining({ reason: "can-commit" }));
  });

  // remote-lead's case from F5: the pair starts adding a VPS, the mini dies before the
  // joint entry commits, the operator breaks the pair on the MacBook, then the mini returns.
  it("breaks a pair whose fallback died mid-edit: one history, the later term wins, nothing lost", () => {
    const cluster = new Cluster(20, ["macbook", "mini", "vps"], ["macbook", "mini"]);
    cluster.run(200);
    expect(cluster.leader()?.id).toBe("macbook");
    expect(cluster.propose("before")).toBeDefined();
    cluster.run(20);
    const macbook = cluster.node("macbook");
    macbook.proposeList(["macbook", "mini", "vps"]);
    macbook.propose("waiting");
    cluster.drain("macbook");
    cluster.crash("mini");
    cluster.run(200);
    expect(cluster.node("macbook").status()).toMatchObject({ canCommit: false, pendingList: { old: ["macbook", "mini"] } });
    expect(cluster.appliedData("macbook")).toEqual(["before"]);

    cluster.node("macbook").alone();
    cluster.drain("macbook");
    const broken = cluster.node("macbook").status();
    expect(broken).toMatchObject({ role: "leader", canCommit: true, members: { list: ["macbook", "mini"], sole: "macbook" } });
    expect(broken.pendingList).toBeUndefined();
    cluster.run(5);
    // The data that waited behind the edit commits in the new term.
    expect(cluster.appliedData("macbook")).toEqual(["before", "waiting"]);
    expect(cluster.propose("after")).toBeDefined();

    cluster.boot("mini");
    cluster.run(300);
    expect(cluster.node("mini").status()).toMatchObject({ role: "follower", term: broken.term, leader: "macbook" });
    for (const id of ["macbook", "mini"]) expect(cluster.appliedData(id)).toEqual(["before", "waiting", "after"]);
    expect(cluster.applied.get("mini")).toEqual(cluster.applied.get("macbook"));
    expect(cluster.revoked).toEqual([]);
    cluster.checkLogs();
  });

  it("rules on the machine the operator says survived, and revokes what the other committed after the cut", () => {
    const cluster = new Cluster(13, ["macbook", "mini"], ["macbook", "mini"]);
    cluster.run(200);
    cluster.partition(["macbook"], ["mini"]);
    cluster.run(400);
    // The fallback keeps committing; the operator wrongly says it is dead.
    expect(cluster.propose("majority side")).toBeDefined();
    const before = cluster.node("macbook").status().term;
    cluster.diverged = true;
    cluster.node("macbook").alone();
    cluster.drain("macbook");
    expect(cluster.node("macbook").status()).toMatchObject({ role: "leader", term: before + ALONE_TERM_STRIDE });
    cluster.run(20);
    expect(cluster.appliedData("macbook")).not.toContain("majority side");
    const alone = cluster.node("macbook").propose("alone side");
    cluster.drain("macbook");
    cluster.run(5);
    expect(cluster.applied.get("macbook")!.some(entry => entry.index === alone.index)).toBe(true);
    cluster.heal();
    cluster.run(400);
    // The others follow the operator's machine; what they committed after the cut comes back as revoked.
    expect(cluster.revoked.some(({ entry }) => entry.payload.kind === "data" && entry.payload.data === "majority side")).toBe(true);
    expect(cluster.appliedData("mini")).toContain("alone side");
    cluster.checkConverged();
  });
});
