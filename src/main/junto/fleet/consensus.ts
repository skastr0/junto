/**
 * One authority for a canvas, held by quorum commit (plan 0.11/06, Design,
 * section 1; tech-lead's F1). This is the pure core: one consensus group per
 * canvas, Raft in etcd/raft's shape. It does no I/O, reads no clock and runs
 * no Effect: the driver feeds it ticks, messages and proposals, then drains
 * `ready()` and, in this order, persists what it says, sends its messages and
 * applies its committed entries. The deterministic simulation
 * (tests/fleet-consensus-sim.test.ts) runs this same core.
 *
 * Where it differs from textbook Raft, each for a decision in 06:
 *
 * - **Quorums follow the operator's ordered list.** One machine commits alone;
 *   a pair's quorums all contain the fallback (the second), so the fallback
 *   rules all night on its own vote; three or more use a majority.
 * - **List edits use joint consensus**, never a single-server change: a pair's
 *   quorum is not a majority, so an old and a new list can have disjoint
 *   quorums ({mini} and {MacBook, VPS} when a VPS joins MacBook and mini).
 *   A joint entry needs a quorum of both lists, then the new list follows.
 * - **Priority.** A machine stands for election only after its rank's extra
 *   timeouts (rank 0 after one, rank 1 after two), and the authority hands
 *   over to a higher-ranked machine once it has caught up.
 * - **Pre-vote** keeps a machine back from a partition from raising the term.
 * - **`alone`**: the operator's statement on a listed machine that the others
 *   are dead. It starts a term no election reaches (`ALONE_TERM_STRIDE` past
 *   its own) whose list names this machine as sole voter. It is outside
 *   Raft's guarantees by definition and the one path to divergence: entries
 *   a machine committed and then loses to it come out as `revoked`.
 * - **Freshness, not safety, uses time**: an authority that has not heard a
 *   quorum within an election timeout reports `fresh: false` (CheckQuorum).
 */

export type MachineId = string;

/** The ordered authority list. `old` is set while a list edit is joint; `sole` after `alone`. */
export type MemberList = {
  readonly list: ReadonlyArray<MachineId>;
  readonly old?: ReadonlyArray<MachineId>;
  readonly sole?: MachineId;
};

/** What an entry carries. The core reads only `list`; the rest is the driver's. */
export type EntryPayload =
  | { readonly kind: "noop" }
  | { readonly kind: "list"; readonly members: MemberList }
  | { readonly kind: "data"; readonly data: string };

export type Entry = { readonly term: number; readonly index: number; readonly payload: EntryPayload };

export type HardState = { readonly term: number; readonly votedFor: MachineId | null; readonly commit: number };

export type Message =
  | { readonly type: "pre-vote"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly lastIndex: number; readonly lastTerm: number }
  | { readonly type: "pre-vote-reply"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly granted: boolean }
  | { readonly type: "vote"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly lastIndex: number; readonly lastTerm: number; readonly transfer: boolean }
  | { readonly type: "vote-reply"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly granted: boolean }
  | { readonly type: "append"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly prevIndex: number; readonly prevTerm: number; readonly entries: ReadonlyArray<Entry>; readonly commit: number }
  | { readonly type: "append-reply"; readonly from: MachineId; readonly to: MachineId; readonly term: number; readonly success: boolean; readonly index: number }
  | { readonly type: "timeout-now"; readonly from: MachineId; readonly to: MachineId; readonly term: number };

export type Role = "follower" | "pre-candidate" | "candidate" | "leader";

/** What the driver must do, in order: persist, send, apply. */
export type Ready = {
  /** Set when term, vote or commit changed: persist before sending. */
  readonly hardState?: HardState;
  /** Drop every persisted entry from this index, then write `entries`. */
  readonly truncateFrom?: number;
  /** Each written at its own index, replacing that entry and every one after it. */
  readonly entries: ReadonlyArray<Entry>;
  readonly messages: ReadonlyArray<Message>;
  /** Newly committed entries, in index order, to apply. */
  readonly committed: ReadonlyArray<Entry>;
  /** Entries this machine had committed and lost to an `alone` fork: the driver queues their commands again. */
  readonly revoked: ReadonlyArray<Entry>;
};

export type ConsensusOptions = {
  readonly id: MachineId;
  /** Ticks without hearing an authority before rank 0 stands. */
  readonly electionTicks: number;
  /** Ticks between an authority's heartbeats. */
  readonly heartbeatTicks: number;
  /** Extra ticks added to each election timeout, so machines that lost the same authority do not stand together; 0 by default. The simulation seeds it. */
  readonly jitter?: () => number;
  /** Entries in one append at most. */
  readonly maxEntriesPerAppend?: number;
  /** What this machine persisted; a new machine starts empty with the first list as entry 1. */
  readonly hardState: HardState;
  readonly log: ReadonlyArray<Entry>;
};

export type Status = {
  readonly id: MachineId;
  readonly role: Role;
  readonly term: number;
  readonly leader: MachineId | null;
  readonly commit: number;
  readonly lastIndex: number;
  /** The committed list: who rules this canvas now. */
  readonly members: MemberList;
  /** The latest list entry when it is not yet committed (a joint edit, or `alone` not yet applied); absent otherwise. */
  readonly pendingList?: MemberList;
  /**
   * An authority that heard a quorum within an election timeout, or is a
   * quorum on its own (one machine, a pair's fallback, `alone`); false
   * everywhere else.
   */
  readonly fresh: boolean;
  /** This machine takes a proposal now and can commit it: a fresh authority not handing over. The one definition. */
  readonly canCommit: boolean;
};

/** How far `alone` moves the term: past any term an election reaches, so its term is never shared. */
export const ALONE_TERM_STRIDE = 2 ** 20;

export class ProposalRefused extends Error {
  constructor(readonly reason: "not-leader" | "transferring" | "list-pending" | "not-member" | "not-pair" | "can-commit") {
    super(`proposal refused: ${reason}`);
  }
}

/** Whether `acks` is a quorum of one list. */
export const isListQuorum = (list: ReadonlyArray<MachineId>, acks: ReadonlySet<MachineId>): boolean => {
  if (list.length === 0) return false;
  if (list.length === 1) return acks.has(list[0]!);
  // A pair: every quorum holds the fallback, so the fallback alone is one.
  if (list.length === 2) return acks.has(list[1]!);
  return list.filter(id => acks.has(id)).length * 2 > list.length;
};

/** Whether `acks` is a quorum of the members as they stand: both lists while joint, the sole voter after `alone`. */
export const isQuorum = (members: MemberList, acks: ReadonlySet<MachineId>): boolean => {
  if (members.sole !== undefined) return acks.has(members.sole);
  return isListQuorum(members.list, acks) && (members.old === undefined || isListQuorum(members.old, acks));
};

const voters = (members: MemberList): ReadonlyArray<MachineId> =>
  [...new Set([...members.list, ...(members.old ?? []), ...(members.sole === undefined ? [] : [members.sole])])];

/** A machine's rank: its place in the list, then in the old list while joint; undefined when it may not stand. */
const rankOf = (members: MemberList, id: MachineId): number | undefined => {
  if (members.sole !== undefined) return members.sole === id ? 0 : undefined;
  const at = members.list.indexOf(id);
  if (at >= 0) return at;
  const old = members.old?.indexOf(id) ?? -1;
  return old < 0 ? undefined : members.list.length + old;
};

export class ConsensusNode {
  readonly id: MachineId;
  private readonly electionTicks: number;
  private readonly heartbeatTicks: number;
  private readonly jitter: () => number;
  private readonly maxEntries: number;

  private term: number;
  private votedFor: MachineId | null;
  private commit: number;
  private log: Entry[];
  private applied: number;

  private role: Role = "follower";
  private leader: MachineId | null = null;
  private elapsed = 0;
  private timeout = 0;
  private heartbeatElapsed = 0;
  private votes = new Set<MachineId>();
  private matchIndex = new Map<MachineId, number>();
  private nextIndex = new Map<MachineId, number>();
  private heardSince = new Set<MachineId>();
  private quorumElapsed = 0;
  private fresh = false;
  private transferTo: MachineId | null = null;
  private transferElapsed = 0;

  // The ready under construction.
  private hardDirty = false;
  private truncateFrom: number | undefined;
  private appended: Entry[] = [];
  private outbox: Message[] = [];
  private revoked: Entry[] = [];

  constructor(options: ConsensusOptions) {
    this.id = options.id;
    this.electionTicks = options.electionTicks;
    this.heartbeatTicks = options.heartbeatTicks;
    this.jitter = options.jitter ?? (() => 0);
    this.maxEntries = options.maxEntriesPerAppend ?? 64;
    this.term = options.hardState.term;
    this.votedFor = options.hardState.votedFor;
    this.log = [...options.log];
    this.commit = Math.min(options.hardState.commit, this.lastIndex());
    // Everything committed before a restart was applied before it: the driver applies in the same transaction it persists.
    this.applied = this.commit;
    this.resetTimeout();
  }

  // ---- reading -------------------------------------------------------------

  private lastIndex(): number { return this.log.length === 0 ? 0 : this.log[this.log.length - 1]!.index; }
  private entryAt(index: number): Entry | undefined { return index <= 0 ? undefined : this.log[index - 1]; }
  private termAt(index: number): number { return index === 0 ? 0 : this.entryAt(index)?.term ?? -1; }
  private lastTerm(): number { return this.termAt(this.lastIndex()); }

  /** The members as the log states them: the latest list entry, committed or not (Raft's rule). */
  members(): MemberList {
    for (let at = this.log.length - 1; at >= 0; at--) {
      const payload = this.log[at]!.payload;
      if (payload.kind === "list") return payload.members;
    }
    return { list: [] };
  }

  /** The members as of the commit point: the latest committed list entry. */
  private committedMembers(): MemberList {
    for (let at = Math.min(this.commit, this.log.length) - 1; at >= 0; at--) {
      const payload = this.log[at]!.payload;
      if (payload.kind === "list") return payload.members;
    }
    return { list: [] };
  }

  /**
   * This machine's rank for standing: in the latest list, or, when an edit not
   * yet committed drops it, in the committed list. A machine so dropped may
   * hold the only complete log; it stands, wins on the latest list's votes,
   * commits the edit, and then steps down.
   */
  private standing(): number | undefined {
    return rankOf(this.members(), this.id) ?? rankOf(this.committedMembers(), this.id);
  }

  status(): Status {
    const latest = this.members();
    const committed = this.committedMembers();
    const fresh = this.role === "leader" && (this.fresh || isQuorum(latest, new Set([this.id])));
    return {
      id: this.id, role: this.role, term: this.term, leader: this.leader, commit: this.commit,
      lastIndex: this.lastIndex(), members: committed,
      ...(JSON.stringify(latest) === JSON.stringify(committed) ? {} : { pendingList: latest }),
      fresh,
      canCommit: fresh && this.transferTo === null,
    };
  }

  // ---- inputs --------------------------------------------------------------

  tick(): void {
    if (this.role === "leader") {
      this.heartbeatElapsed += 1;
      this.quorumElapsed += 1;
      if (this.quorumElapsed >= this.electionTicks) {
        this.fresh = isQuorum(this.members(), new Set([...this.heardSince, this.id]));
        this.heardSince.clear();
        this.quorumElapsed = 0;
      }
      if (this.heartbeatElapsed >= this.heartbeatTicks) {
        this.heartbeatElapsed = 0;
        this.broadcastAppend();
      }
      // A transfer the target never took ends: the authority takes proposals again.
      if (this.transferTo !== null && ++this.transferElapsed >= this.electionTicks) this.transferTo = null;
      this.considerHandover();
      return;
    }
    this.elapsed += 1;
    if (this.standing() === undefined) return;
    if (this.elapsed >= this.timeout) this.preCampaign();
  }

  /** Propose data. Only the authority takes a proposal; it commits once a quorum holds it. */
  propose(data: string): Entry {
    this.mustLead();
    return this.appendOwn({ kind: "data", data });
  }

  /** Propose a new ordered list: a joint entry now, the new list once that commits. */
  proposeList(list: ReadonlyArray<MachineId>): Entry {
    this.mustLead();
    if (this.listPending()) throw new ProposalRefused("list-pending");
    const current = this.members();
    const old = current.sole === undefined ? current.list : [current.sole];
    return this.appendOwn({ kind: "list", members: { list: [...list], old } });
  }

  /** A clean leave: hand authority to the best caught-up machine, or to `target`. */
  transfer(target?: MachineId): void {
    if (this.role !== "leader") return;
    const to = target ?? this.handoverTarget(Number.POSITIVE_INFINITY);
    if (to === undefined || to === this.id) return;
    this.transferTo = to;
    this.transferElapsed = 0;
    this.sendAppend(to);
    this.maybeTimeoutNow();
  }

  /**
   * `junto authority alone`: the operator says the other machine of a pair is
   * dead. Only for a committed pair this machine is in, and only while it
   * cannot commit. The fork drops everything above the commit point, a list
   * edit pending there included, so a pair whose other machine died mid-edit
   * can still be broken; the dropped data comes back in the new term, so
   * nothing waiting is lost. This machine is then the sole voter. It keeps
   * the pair, so the other follows it on contact and loses to the later term.
   */
  alone(): void {
    const committed = this.committedMembers();
    if (committed.sole !== undefined || committed.old !== undefined || committed.list.length !== 2) throw new ProposalRefused("not-pair");
    if (!committed.list.includes(this.id)) throw new ProposalRefused("not-member");
    if (this.status().canCommit) throw new ProposalRefused("can-commit");
    const dropped = this.log.slice(this.commit);
    if (dropped.length > 0) {
      this.log.length = this.commit;
      this.truncateFrom = Math.min(this.truncateFrom ?? Number.POSITIVE_INFINITY, this.commit + 1);
      this.appended = this.appended.filter(kept => kept.index <= this.commit);
    }
    this.setTerm(this.term + ALONE_TERM_STRIDE, this.id);
    this.becomeLeader();
    this.appendOwn({ kind: "list", members: { list: [...committed.list], sole: this.id } });
    for (const entry of dropped) if (entry.payload.kind === "data") this.appendOwn(entry.payload);
  }

  step(message: Message): void {
    if (message.to !== this.id) return;
    // Pre-votes travel at a term not yet taken: they never move anyone's term.
    if (message.type === "pre-vote") return this.onPreVote(message);
    if (message.type === "pre-vote-reply") {
      // A refusal from a later term teaches it: a machine whose term ran ahead can then grant.
      if (!message.granted && message.term > this.term) return this.becomeFollower(message.term, null);
      return this.onPreVoteReply(message);
    }

    if (message.term > this.term) {
      // A vote request from a machine back from a partition does not unseat a live authority,
      // unless the authority itself asked for it (a transfer).
      if (message.type === "vote" && !message.transfer && this.leader !== null && this.elapsed < this.electionTicks) {
        this.outbox.push({ type: "vote-reply", from: this.id, to: message.from, term: this.term, granted: false });
        return;
      }
      this.becomeFollower(message.term, message.type === "append" || message.type === "timeout-now" ? message.from : null);
    } else if (message.term < this.term) {
      // A stale sender learns the term from the refusal.
      if (message.type === "append") this.outbox.push({ type: "append-reply", from: this.id, to: message.from, term: this.term, success: false, index: this.lastIndex() });
      if (message.type === "vote") this.outbox.push({ type: "vote-reply", from: this.id, to: message.from, term: this.term, granted: false });
      return;
    }

    switch (message.type) {
      case "vote": return this.onVote(message);
      case "vote-reply": return this.onVoteReply(message);
      case "append": return this.onAppend(message);
      case "append-reply": return this.onAppendReply(message);
      case "timeout-now": return this.campaign(true);
    }
  }

  ready(): Ready {
    const committed: Entry[] = [];
    while (this.applied < this.commit) {
      this.applied += 1;
      committed.push(this.entryAt(this.applied)!);
    }
    const out: Ready = {
      ...(this.hardDirty ? { hardState: { term: this.term, votedFor: this.votedFor, commit: this.commit } } : {}),
      ...(this.truncateFrom === undefined ? {} : { truncateFrom: this.truncateFrom }),
      entries: this.appended,
      messages: this.outbox,
      committed,
      revoked: this.revoked,
    };
    this.hardDirty = false;
    this.truncateFrom = undefined;
    this.appended = [];
    this.outbox = [];
    this.revoked = [];
    return out;
  }

  // ---- roles ---------------------------------------------------------------

  private setTerm(term: number, votedFor: MachineId | null): void {
    if (term !== this.term || votedFor !== this.votedFor) this.hardDirty = true;
    this.term = term;
    this.votedFor = votedFor;
  }

  private becomeFollower(term: number, leader: MachineId | null): void {
    this.setTerm(term, term === this.term ? this.votedFor : null);
    this.role = "follower";
    this.leader = leader;
    this.elapsed = 0;
    this.resetTimeout();
    this.transferTo = null;
    this.fresh = false;
  }

  private becomeLeader(): void {
    this.role = "leader";
    this.leader = this.id;
    this.heartbeatElapsed = 0;
    this.quorumElapsed = 0;
    this.heardSince.clear();
    this.fresh = false;
    this.transferTo = null;
    this.matchIndex.clear();
    this.nextIndex.clear();
    for (const peer of voters(this.members())) {
      this.nextIndex.set(peer, this.lastIndex() + 1);
      this.matchIndex.set(peer, peer === this.id ? this.lastIndex() : 0);
    }
  }

  /** Rank 0 stands after one election timeout, rank 1 after two, each plus its jitter. */
  private resetTimeout(): void {
    const rank = this.standing() ?? 0;
    this.timeout = this.electionTicks * (1 + rank) + Math.max(0, Math.floor(this.jitter()));
  }

  private preCampaign(): void {
    const members = this.members();
    this.elapsed = 0;
    this.resetTimeout();
    this.role = "pre-candidate";
    this.leader = null;
    this.votes = new Set([this.id]);
    if (isQuorum(members, this.votes)) return this.campaign(false);
    for (const peer of voters(members)) {
      if (peer === this.id) continue;
      this.outbox.push({ type: "pre-vote", from: this.id, to: peer, term: this.term + 1, lastIndex: this.lastIndex(), lastTerm: this.lastTerm() });
    }
  }

  private campaign(transfer: boolean): void {
    const members = this.members();
    if (this.standing() === undefined) return;
    this.setTerm(this.term + 1, this.id);
    this.role = "candidate";
    this.leader = null;
    this.elapsed = 0;
    this.resetTimeout();
    this.votes = new Set([this.id]);
    if (isQuorum(members, this.votes)) return this.winElection();
    for (const peer of voters(members)) {
      if (peer === this.id) continue;
      this.outbox.push({ type: "vote", from: this.id, to: peer, term: this.term, lastIndex: this.lastIndex(), lastTerm: this.lastTerm(), transfer });
    }
  }

  private winElection(): void {
    this.becomeLeader();
    // A new term commits nothing of an earlier one until an entry of its own does (Raft 5.4.2).
    this.appendOwn({ kind: "noop" });
  }

  private upToDate(lastIndex: number, lastTerm: number): boolean {
    return lastTerm > this.lastTerm() || (lastTerm === this.lastTerm() && lastIndex >= this.lastIndex());
  }

  private onPreVote(message: Extract<Message, { type: "pre-vote" }>): void {
    // Granted only by a machine that has not heard an authority lately, to a log at least as complete.
    const heardLeader = this.role === "leader" || (this.leader !== null && this.elapsed < this.electionTicks);
    const granted = message.term > this.term && !heardLeader && this.upToDate(message.lastIndex, message.lastTerm);
    this.outbox.push({ type: "pre-vote-reply", from: this.id, to: message.from, term: granted ? message.term : this.term, granted });
  }

  private onPreVoteReply(message: Extract<Message, { type: "pre-vote-reply" }>): void {
    if (this.role !== "pre-candidate" || message.term !== this.term + 1 || !message.granted) return;
    this.votes.add(message.from);
    if (isQuorum(this.members(), this.votes)) this.campaign(false);
  }

  private onVote(message: Extract<Message, { type: "vote" }>): void {
    const free = this.votedFor === null || this.votedFor === message.from;
    const granted = free && this.upToDate(message.lastIndex, message.lastTerm);
    if (granted) {
      this.setTerm(this.term, message.from);
      this.elapsed = 0;
    }
    this.outbox.push({ type: "vote-reply", from: this.id, to: message.from, term: this.term, granted });
  }

  private onVoteReply(message: Extract<Message, { type: "vote-reply" }>): void {
    if (this.role !== "candidate" || !message.granted) return;
    this.votes.add(message.from);
    if (isQuorum(this.members(), this.votes)) this.winElection();
  }

  // ---- replication ---------------------------------------------------------

  private mustLead(): void {
    if (this.role !== "leader") throw new ProposalRefused("not-leader");
    if (this.transferTo !== null) throw new ProposalRefused("transferring");
  }

  private listPending(): boolean {
    for (let at = this.log.length - 1; at >= this.commit; at--) {
      if (this.log[at]!.payload.kind === "list") return true;
    }
    return this.members().old !== undefined;
  }

  private appendOwn(payload: EntryPayload): Entry {
    const entry: Entry = { term: this.term, index: this.lastIndex() + 1, payload };
    this.log.push(entry);
    this.appended.push(entry);
    if (payload.kind === "list") {
      // A new member starts from nothing; a member that left is no longer sent to.
      for (const peer of voters(payload.members)) {
        if (!this.nextIndex.has(peer)) {
          this.nextIndex.set(peer, 1);
          this.matchIndex.set(peer, 0);
        }
      }
    }
    this.matchIndex.set(this.id, entry.index);
    this.maybeCommit();
    this.broadcastAppend();
    return entry;
  }

  private broadcastAppend(): void {
    for (const peer of voters(this.members())) if (peer !== this.id) this.sendAppend(peer);
  }

  private sendAppend(peer: MachineId): void {
    const next = this.nextIndex.get(peer) ?? this.lastIndex() + 1;
    const prevIndex = Math.max(0, next - 1);
    this.outbox.push({
      type: "append", from: this.id, to: peer, term: this.term,
      prevIndex, prevTerm: this.termAt(prevIndex),
      entries: this.log.slice(prevIndex, prevIndex + this.maxEntries), commit: this.commit,
    });
  }

  private onAppend(message: Extract<Message, { type: "append" }>): void {
    if (this.role !== "follower") this.becomeFollower(this.term, message.from);
    this.leader = message.from;
    this.elapsed = 0;
    if (message.prevIndex > this.lastIndex() || this.termAt(message.prevIndex) !== message.prevTerm) {
      this.outbox.push({ type: "append-reply", from: this.id, to: message.from, term: this.term, success: false, index: Math.min(this.lastIndex(), message.prevIndex - 1) });
      return;
    }
    for (const entry of message.entries) {
      const held = this.entryAt(entry.index);
      if (held !== undefined && held.term === entry.term) continue;
      if (held !== undefined) {
        // A conflict: everything from here goes. Below the commit point only an `alone` fork does this.
        const lost = this.log.slice(entry.index - 1);
        for (const gone of lost) if (gone.index <= this.applied) this.revoked.push(gone);
        this.log.length = entry.index - 1;
        this.truncateFrom = Math.min(this.truncateFrom ?? Number.POSITIVE_INFINITY, entry.index);
        this.appended = this.appended.filter(kept => kept.index < entry.index);
        if (this.commit >= entry.index) { this.commit = entry.index - 1; this.hardDirty = true; }
        if (this.applied >= entry.index) this.applied = entry.index - 1;
      }
      this.log.push(entry);
      this.appended.push(entry);
    }
    const last = message.prevIndex + message.entries.length;
    const commit = Math.min(message.commit, last);
    if (commit > this.commit) { this.commit = commit; this.hardDirty = true; }
    this.outbox.push({ type: "append-reply", from: this.id, to: message.from, term: this.term, success: true, index: last });
  }

  private onAppendReply(message: Extract<Message, { type: "append-reply" }>): void {
    if (this.role !== "leader") return;
    this.heardSince.add(message.from);
    // Fresh as soon as a quorum answers; it lapses only at a window's end that heard none.
    if (isQuorum(this.members(), new Set([...this.heardSince, this.id]))) this.fresh = true;
    if (!message.success) {
      this.nextIndex.set(message.from, Math.max(1, Math.min(message.index + 1, (this.nextIndex.get(message.from) ?? 1) - 1)));
      this.sendAppend(message.from);
      return;
    }
    if (message.index > (this.matchIndex.get(message.from) ?? 0)) this.matchIndex.set(message.from, message.index);
    this.nextIndex.set(message.from, Math.max(this.nextIndex.get(message.from) ?? 1, message.index + 1));
    this.maybeCommit();
    this.maybeTimeoutNow();
  }

  private maybeCommit(): void {
    const members = this.members();
    for (let index = this.lastIndex(); index > this.commit; index--) {
      if (this.termAt(index) !== this.term) break;
      const holders = new Set<MachineId>([...this.matchIndex].filter(([, match]) => match >= index).map(([peer]) => peer));
      if (!isQuorum(members, holders)) continue;
      this.commit = index;
      this.hardDirty = true;
      this.afterCommit();
      return;
    }
  }

  /** A committed joint list is followed by the new list; a leader the list no longer names steps down. */
  private afterCommit(): void {
    const members = this.members();
    let latest = 0;
    for (let at = this.log.length - 1; at >= 0 && latest === 0; at--) if (this.log[at]!.payload.kind === "list") latest = at + 1;
    if (latest === 0 || latest > this.commit) return;
    if (members.old !== undefined) {
      this.appendOwn({ kind: "list", members: { list: [...members.list] } });
      return;
    }
    if (rankOf(members, this.id) === undefined) this.becomeFollower(this.term, null);
  }

  // ---- handover --------------------------------------------------------------

  /** The best caught-up machine ranked above `below`, if one has heard us lately. */
  private handoverTarget(below: number): MachineId | undefined {
    const members = this.members();
    if (members.sole !== undefined || members.old !== undefined) return undefined;
    for (const [rank, peer] of members.list.entries()) {
      if (rank >= below) return undefined;
      if (peer === this.id) continue;
      if ((this.matchIndex.get(peer) ?? 0) === this.lastIndex()) return peer;
    }
    return undefined;
  }

  /** Authority goes back up the list: a higher-ranked machine that has caught up takes it. */
  private considerHandover(): void {
    if (this.transferTo !== null) return;
    const rank = rankOf(this.members(), this.id);
    if (rank === undefined || rank === 0 || !this.fresh) return;
    const to = this.handoverTarget(rank);
    if (to !== undefined) this.transfer(to);
  }

  private maybeTimeoutNow(): void {
    const to = this.transferTo;
    if (to === null || (this.matchIndex.get(to) ?? 0) !== this.lastIndex()) return;
    this.outbox.push({ type: "timeout-now", from: this.id, to, term: this.term });
  }
}
