/**
 * The fleet consensus core (plan 0.11/06, F1): quorums from the operator's
 * ordered list, the pair's casting vote, priority and handover, pre-vote,
 * joint list edits and `alone`. Each case runs the pure core under the
 * deterministic simulation (tests/support/consensus-sim.ts), whose checks of
 * Raft's safety properties run after every step.
 */
import { describe, expect, it } from "vitest";
import { ALONE_TERM_STRIDE, isListQuorum, isQuorum, ProposalRefused } from "../src/main/junto/fleet/consensus";
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
  it("rules on one machine the operator says survived, and revokes what the others committed after the cut", () => {
    const cluster = new Cluster(13, ["macbook", "mini", "vps"], ["macbook", "mini", "vps"]);
    cluster.run(200);
    cluster.partition(["macbook"], ["mini", "vps"]);
    cluster.run(400);
    // The majority side keeps committing; the operator wrongly says it is dead.
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
    for (const id of ["mini", "vps"]) expect(cluster.appliedData(id)).toContain("alone side");
    cluster.checkConverged();
  });
});
