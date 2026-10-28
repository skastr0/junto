/**
 * A deterministic simulation of the fleet consensus core (plan 0.11/06, F1):
 * a seeded scheduler, a virtual clock, and a network that delays, drops,
 * duplicates and reorders, cuts machines apart and crashes them. Each machine
 * is driven exactly as the real driver is: drain `ready()`, persist, send,
 * apply. Every check below runs after every step, so a failure names the
 * tick and the seed that reproduce it.
 *
 * Raft's safety properties, checked: election safety (one authority per
 * term), log matching, leader completeness and state machine safety. Ours:
 * every commit is held by a quorum of the authority's own list (so a pair's
 * fallback always holds it), and nothing committed is revoked without
 * `alone`.
 */
import {
  ConsensusNode,
  isListQuorum,
  isQuorum,
  type Entry,
  type HardState,
  type MachineId,
  type MemberList,
  type Message,
} from "../../src/main/junto/fleet/consensus";

/** mulberry32: small, fast, and the same everywhere. */
export const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number): boolean => next() < p,
    pick: <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)]!,
  };
};

export type Faults = {
  readonly drop: number;
  readonly duplicate: number;
  readonly maxDelay: number;
};

export const CALM: Faults = { drop: 0, duplicate: 0, maxDelay: 1 };

type Stored = { hardState: HardState; log: Entry[] };

const same = (a: Entry, b: Entry): boolean => a.term === b.term && JSON.stringify(a.payload) === JSON.stringify(b.payload);
const pairKey = (a: MachineId, b: MachineId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class Cluster {
  readonly rng: ReturnType<typeof seeded>;
  now = 0;
  faults: Faults;
  readonly nodes = new Map<MachineId, ConsensusNode>();
  readonly stored = new Map<MachineId, Stored>();
  /** What each machine applied, in order: the driver's state, kept across a restart. */
  readonly applied = new Map<MachineId, Entry[]>();
  readonly dead = new Set<MachineId>();
  readonly cut = new Set<string>();
  readonly leaders = new Map<number, MachineId>();
  readonly revoked: Array<{ readonly id: MachineId; readonly entry: Entry }> = [];
  private inflight: Array<{ readonly at: number; readonly seq: number; readonly message: Message }> = [];
  private seq = 0;
  private wasLeader = new Map<MachineId, number>();
  /** Set by a run that uses `alone`: leader completeness and applied agreement may break until it converges. */
  diverged = false;

  constructor(
    readonly seed: number,
    /** Every machine the run may use; the ones in `first` start with the first list as entry 1. */
    readonly pool: ReadonlyArray<MachineId>,
    first: ReadonlyArray<MachineId>,
    faults: Faults = CALM,
    readonly electionTicks = 10,
    readonly heartbeatTicks = 3,
  ) {
    this.rng = seeded(seed);
    this.faults = faults;
    const genesis: Entry = { term: 1, index: 1, payload: { kind: "list", members: { list: [...first] } } };
    for (const id of pool) {
      const member = first.includes(id);
      this.stored.set(id, { hardState: { term: member ? 1 : 0, votedFor: null, commit: member ? 1 : 0 }, log: member ? [genesis] : [] });
      this.applied.set(id, member ? [genesis] : []);
      this.boot(id);
    }
  }

  private fail(what: string): never {
    throw new Error(`seed ${this.seed}, tick ${this.now}: ${what}`);
  }

  boot(id: MachineId): void {
    const stored = this.stored.get(id)!;
    this.nodes.set(id, new ConsensusNode({
      id,
      electionTicks: this.electionTicks,
      heartbeatTicks: this.heartbeatTicks,
      jitter: () => this.rng.int(0, this.electionTicks),
      hardState: stored.hardState,
      log: stored.log,
    }));
    this.dead.delete(id);
    this.wasLeader.delete(id);
  }

  crash(id: MachineId): void {
    this.dead.add(id);
    this.nodes.delete(id);
  }

  node(id: MachineId): ConsensusNode {
    const node = this.nodes.get(id);
    if (node === undefined) this.fail(`${id} is down`);
    return node;
  }

  partition(...sides: ReadonlyArray<ReadonlyArray<MachineId>>): void {
    this.cut.clear();
    for (const [i, side] of sides.entries()) {
      for (const other of sides.slice(i + 1)) for (const a of side) for (const b of other) this.cut.add(pairKey(a, b));
    }
  }

  heal(): void {
    this.cut.clear();
  }

  /** Drive one machine's ready: persist, send, apply; then check everything. */
  drain(id: MachineId): void {
    const node = this.nodes.get(id);
    if (node === undefined) return;
    const ready = node.ready();
    const stored = this.stored.get(id)!;
    if (ready.truncateFrom !== undefined) stored.log.length = Math.min(stored.log.length, ready.truncateFrom - 1);
    for (const entry of ready.entries) {
      if (entry.index > stored.log.length + 1) this.fail(`${id} was asked to write ${entry.index} after ${stored.log.length}`);
      stored.log.length = entry.index - 1;
      stored.log.push(entry);
    }
    if (ready.hardState !== undefined) stored.hardState = ready.hardState;
    for (const gone of ready.revoked) this.revoked.push({ id, entry: gone });
    if (ready.revoked.length > 0) {
      const first = ready.revoked[0]!.index;
      this.applied.set(id, this.applied.get(id)!.filter(entry => entry.index < first));
    }
    for (const message of ready.messages) this.send(message);
    const applied = this.applied.get(id)!;
    for (const entry of ready.committed) {
      if (entry.index !== applied.length + 1) this.fail(`${id} applied ${entry.index} after ${applied.length}`);
      const persisted = stored.log[entry.index - 1];
      if (persisted === undefined || !same(persisted, entry)) this.fail(`${id} applied ${entry.index}, which it had not persisted`);
      applied.push(entry);
      if (node.status().role === "leader") this.checkCommitQuorum(node, entry);
    }
    this.observe(node);
  }

  private send(message: Message): void {
    const copies = this.rng.chance(this.faults.duplicate) ? 2 : 1;
    for (let copy = 0; copy < copies; copy++) {
      if (this.rng.chance(this.faults.drop)) continue;
      this.inflight.push({ at: this.now + this.rng.int(1, this.faults.maxDelay), seq: this.seq++, message });
    }
  }

  /** A commit is held, on disk, by a quorum of the authority's own list; a pair's fallback always among them. */
  private checkCommitQuorum(leader: ConsensusNode, entry: Entry): void {
    const members = leader.members();
    const holders = new Set<MachineId>();
    for (const [id, stored] of this.stored) {
      const held = stored.log[entry.index - 1];
      if (held !== undefined && same(held, entry)) holders.add(id);
    }
    if (!isQuorum(members, holders)) this.fail(`${leader.id} committed ${entry.index} held only by ${[...holders].join(",")}`);
    if (members.sole === undefined && members.list.length === 2 && !holders.has(members.list[1]!)) {
      this.fail(`${leader.id} committed ${entry.index} without the fallback ${members.list[1]}`);
    }
    if (members.old?.length === 2 && !holders.has(members.old[1]!)) this.fail(`${leader.id} committed ${entry.index} without the old fallback`);
  }

  private observe(node: ConsensusNode): void {
    const status = node.status();
    if (status.role !== "leader") {
      this.wasLeader.delete(node.id);
      return;
    }
    if (this.wasLeader.get(node.id) === status.term) return;
    this.wasLeader.set(node.id, status.term);
    // Election safety.
    const held = this.leaders.get(status.term);
    if (held !== undefined && held !== node.id) this.fail(`term ${status.term} has two authorities: ${held} and ${node.id}`);
    this.leaders.set(status.term, node.id);
    if (this.diverged) return;
    // Leader completeness: everything applied anywhere is in the new authority's log.
    const log = this.stored.get(node.id)!.log;
    for (const [id, applied] of this.applied) {
      for (const entry of applied) {
        const mine = log[entry.index - 1];
        if (mine === undefined || !same(mine, entry)) this.fail(`${node.id} leads term ${status.term} without ${entry.index}, applied on ${id}`);
      }
    }
  }

  /** Log matching and state machine safety across every machine. */
  checkLogs(): void {
    const ids = [...this.stored.keys()];
    for (const [i, a] of ids.entries()) {
      for (const b of ids.slice(i + 1)) {
        const la = this.stored.get(a)!.log;
        const lb = this.stored.get(b)!.log;
        const shared = Math.min(la.length, lb.length);
        let matched = 0;
        for (let at = shared - 1; at >= 0; at--) if (la[at]!.term === lb[at]!.term) { matched = at + 1; break; }
        for (let at = 0; at < matched; at++) if (!same(la[at]!, lb[at]!)) this.fail(`${a} and ${b} match at ${matched} but differ at ${at + 1}`);
        if (this.diverged) continue;
        const pa = this.applied.get(a)!;
        const pb = this.applied.get(b)!;
        for (let at = 0; at < Math.min(pa.length, pb.length); at++) {
          if (!same(pa[at]!, pb[at]!)) this.fail(`${a} and ${b} applied different entries at ${at + 1}`);
        }
      }
    }
  }

  /** One tick of virtual time: every live machine ticks, then every message due arrives. */
  tick(): void {
    this.now += 1;
    for (const id of [...this.nodes.keys()]) {
      this.nodes.get(id)?.tick();
      this.drain(id);
    }
    // Delivery order is the scheduler's: due messages in a seeded shuffle, which reorders.
    const due = this.inflight.filter(item => item.at <= this.now);
    this.inflight = this.inflight.filter(item => item.at > this.now);
    for (let at = due.length - 1; at > 0; at--) {
      const swap = this.rng.int(0, at);
      [due[at], due[swap]] = [due[swap]!, due[at]!];
    }
    for (const { message } of due) {
      if (this.dead.has(message.to) || this.cut.has(pairKey(message.from, message.to))) continue;
      const node = this.nodes.get(message.to);
      if (node === undefined) continue;
      node.step(message);
      this.drain(message.to);
    }
  }

  run(ticks: number, each?: () => void): void {
    for (let t = 0; t < ticks; t++) {
      this.tick();
      each?.();
    }
    this.checkLogs();
  }

  /** Every live machine applied the same entries, after a run that diverged. */
  checkConverged(): void {
    const [first, ...rest] = [...this.nodes.keys()].map(id => [id, this.applied.get(id)!] as const);
    for (const [id, applied] of rest) {
      if (JSON.stringify(applied) !== JSON.stringify(first![1])) this.fail(`${id} and ${first![0]} did not converge`);
    }
  }

  leader(): ConsensusNode | undefined {
    let best: ConsensusNode | undefined;
    for (const node of this.nodes.values()) {
      const status = node.status();
      if (status.role === "leader" && (best === undefined || status.term > best.status().term)) best = node;
    }
    return best;
  }

  /** Run until a leader commits `data`; undefined when none did in time. */
  propose(data: string, within = 400): Entry | undefined {
    for (let t = 0; t < within; t++) {
      const leader = this.leader();
      if (leader !== undefined) {
        try {
          const entry = leader.propose(data);
          this.drain(leader.id);
          for (let wait = 0; wait < within; wait++) {
            this.tick();
            if ((this.applied.get(leader.id) ?? []).some(applied => same(applied, entry) && applied.index === entry.index)) return entry;
            if (this.nodes.get(leader.id)?.status().role !== "leader") break;
          }
        } catch {
          // A transfer in flight, or a list change pending: try again on the next tick.
        }
      }
      this.tick();
    }
    return undefined;
  }

  appliedData(id: MachineId): ReadonlyArray<string> {
    return (this.applied.get(id) ?? []).flatMap(entry => (entry.payload.kind === "data" ? [entry.payload.data] : []));
  }

  committedList(id: MachineId): MemberList | undefined {
    const applied = this.applied.get(id) ?? [];
    for (let at = applied.length - 1; at >= 0; at--) {
      const payload = applied[at]!.payload;
      if (payload.kind === "list") return payload.members;
    }
    return undefined;
  }
}

export { isListQuorum };
