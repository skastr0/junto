import type {
  AgentReply,
  ChatEvent,
  ChatModelChoice,
  ChatOpenResult,
  ChatTurnResult,
} from "@shared/ipc";
import { Context } from "effect";
import { hermesKeyFor, hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import { subscribeHostsSnapshot } from "../hosts/snapshot";
import {
  AcpClient,
  AcpRpcError,
  type AcpHostLocality,
  type AcpTeardownResult,
  type AcpLifecycleEvent,
  type JsonRpcId,
  type SpawnFn,
} from "./acp-client";
import { buildAcpSpawnTarget, resolveSessionCwd, type AcpSpawnTarget } from "./spawn";

// One live ACP session per agent node ("<host>:<profile>"). ChatService owns
// spawn/initialize/session lifecycle and the ACP <-> ChatEvent projection;
// the IPC layer (chat/ipc.ts, wired by the orchestrator) is a thin
// pass-through onto this class.
//
// ACP is a transport, never a kind: this surface holds no seat, mints no
// principal, and takes part in no factory decision.

interface AgentSession {
  readonly client: AcpClient;
  readonly generation: number;
  /** Exact Hermes host id from the agent key (station self | enrolled remote). */
  readonly host: string;
  sessionId: string;
  models: ReadonlyArray<ChatModelChoice>;
  promptInFlight: boolean;
  replyChunks: string[];
  // requestId (stringified JSON-RPC id) -> the original id, so a later
  // chatPermission call can echo it back to the agent unchanged.
  readonly pendingPermissions: Map<string, JsonRpcId>;
  /** Last user-facing activity (open / prompt / permission). Idle eviction uses this. */
  lastActivityAt: number;
}

// Per-host ceiling for remote (SSH-backed) ACP sessions. Local is uncapped
// by this policy — local children do not hold a ControlMaster TCP mux.
const maxRemoteSessionsPerHost = (): number => {
  const raw = Number(process.env.VELLUM_ACP_MAX_REMOTE_SESSIONS_PER_HOST ?? "8");
  return Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 64) : 8;
};

// Idle sessions with no in-flight turn and no pending permission are closed.
// Active turns are never evicted. 0 disables idle eviction.
const idleEvictMs = (): number => {
  const raw = Number(process.env.VELLUM_ACP_IDLE_MS ?? String(15 * 60_000));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 15 * 60_000;
};

export type HermesHostLocality = AcpHostLocality;

const remoteHermesRoutes = (
  hosts: ReadonlyArray<RemoteHost>,
): ReadonlyMap<string, string> =>
  new Map(
    hosts
      .filter(
        (host) =>
          host.kind === "remote" &&
          host.sshEndpoint !== undefined &&
          hostHasCapability(host, "hermes"),
      )
      .map((host) => [hermesKeyFor(host), host.sshEndpoint!] as const),
  );

interface OpenInFlight {
  readonly generation: number;
  readonly promise: Promise<ChatOpenResult>;
}

interface RawModelInfo {
  readonly modelId?: string;
  readonly description?: string;
}

export interface ChatCloseAllResult {
  readonly clean: boolean;
  readonly teardowns: ReadonlyArray<AcpTeardownResult>;
}

export class ChatShutdownUncleanError extends Error {
  constructor(readonly result: ChatCloseAllResult) {
    super(
      `chat shutdown retained ${result.teardowns.filter((receipt) => receipt.kind !== "terminal").length} unclean teardown(s)`,
    );
    this.name = "ChatShutdownUncleanError";
  }
}

export const requireCleanChatShutdown = (
  result: ChatCloseAllResult,
): ChatCloseAllResult => {
  if (!result.clean) throw new ChatShutdownUncleanError(result);
  return result;
};

interface SessionResultShape {
  readonly sessionId?: string;
  readonly models?: { readonly availableModels?: ReadonlyArray<RawModelInfo> };
}

const toModelChoices = (result: SessionResultShape | null | undefined): ReadonlyArray<ChatModelChoice> =>
  (result?.models?.availableModels ?? [])
    .filter((m): m is RawModelInfo & { modelId: string } => typeof m.modelId === "string")
    .map((m) => ({ modelId: m.modelId, description: m.description }));

const describeAuthMethods = (
  authMethods: ReadonlyArray<{ readonly id?: string; readonly name?: string }> | undefined,
): string => {
  if (!authMethods || authMethods.length === 0) return "";
  const names = authMethods.map((m) => m.name ?? m.id ?? "unknown").join(", ");
  return ` (auth methods available: ${names})`;
};

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class ChatService {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly openInFlight = new Map<string, OpenInFlight>();
  private readonly generations = new Map<string, number>();
  private eventSink: ((event: ChatEvent) => void) | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeHostsSnapshot: (() => void) | undefined;
  private readonly clients = new Set<AcpClient>();
  private readonly closeByClient = new WeakMap<
    AcpClient,
    Promise<ReadonlyArray<AcpTeardownResult>>
  >();
  private readonly clientCloseFlights = new Set<
    Promise<ReadonlyArray<AcpTeardownResult>>
  >();
  private readonly workFlights = new Set<Promise<unknown>>();
  private readonly teardownReceipts: AcpTeardownResult[] = [];
  private closing = false;
  private closeAllFlight: Promise<ChatCloseAllResult> | undefined;

  constructor(
    private readonly spawnFn: SpawnFn,
    private readonly isLocalHost: HermesHostLocality,
  ) {
    // Sweep idle remote sessions on a fixed interval. Unref so the timer
    // alone cannot keep the process alive during headless tests / quit.
    const period = Math.min(Math.max(idleEvictMs() || 60_000, 15_000), 60_000);
    this.idleTimer = setInterval(() => this.evictIdleSessions(), period);
    this.idleTimer.unref?.();
    this.unsubscribeHostsSnapshot = subscribeHostsSnapshot((hosts, previous) => {
      this.reconcileRemoteHostRoutes(hosts, previous);
    });
  }

  setEventSink(sink: (event: ChatEvent) => void): void {
    this.eventSink = sink;
  }

  /** Test / shutdown seam. */
  stopIdleSweep(): void {
    if (this.idleTimer !== undefined) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private touch(session: AgentSession): void {
    session.lastActivityAt = Date.now();
  }

  private reconcileRemoteHostRoutes(
    hosts: ReadonlyArray<RemoteHost>,
    previous: ReadonlyArray<RemoteHost>,
  ): void {
    const nextRoutes = remoteHermesRoutes(hosts);
    const previousRoutes = remoteHermesRoutes(previous);
    const changedHosts = new Set<string>();
    for (const host of new Set([...previousRoutes.keys(), ...nextRoutes.keys()])) {
      if (previousRoutes.get(host) !== nextRoutes.get(host)) changedHosts.add(host);
    }

    for (const [agentKey, session] of this.sessions) {
      if (this.isLocalHost(session.host) || !changedHosts.has(session.host)) continue;
      this.nextGeneration(agentKey);
      this.closeCurrent(agentKey);
      this.emit(agentKey, "status", {
        status: "closed",
        text: `remote chat closed because host ${session.host} routing changed`,
      });
    }
  }

  /**
   * Revoke sessions whose host crossed the local/remote boundary after a
   * station identity change. Both directions close: an old self key must lose
   * process-bound authority, and a newly local key must shed any SSH child
   * before its next open can spawn directly.
   */
  reconcileHostLocality(
    previousLocality: HermesHostLocality,
  ): ReadonlyArray<string> {
    const keys = new Set([
      ...this.sessions.keys(),
      ...this.openInFlight.keys(),
    ]);
    const closed: string[] = [];
    for (const agentKey of keys) {
      const target = buildAcpSpawnTarget(agentKey);
      if (
        target === undefined ||
        previousLocality(target.host) === this.isLocalHost(target.host)
      ) {
        continue;
      }
      this.nextGeneration(agentKey);
      void this.closeCurrent(agentKey);
      this.emit(agentKey, "status", {
        status: "closed",
        text: "chat closed because this machine's identity changed",
      });
      closed.push(agentKey);
    }
    return closed;
  }

  private sessionIsBusy(session: AgentSession): boolean {
    return session.promptInFlight || session.pendingPermissions.size > 0;
  }

  /**
   * Close idle remote sessions. Never evicts local sessions, active turns,
   * or sessions awaiting a permission answer.
   */
  evictIdleSessions(now = Date.now()): ReadonlyArray<string> {
    const idleMs = idleEvictMs();
    if (idleMs <= 0) return [];
    const closed: string[] = [];
    for (const [agentKey, session] of this.sessions) {
      if (this.isLocalHost(session.host)) continue;
      if (this.sessionIsBusy(session)) continue;
      if (session.sessionId === "") continue; // still handshaking
      if (now - session.lastActivityAt < idleMs) continue;
      this.nextGeneration(agentKey);
      this.closeCurrent(agentKey);
      closed.push(agentKey);
      this.emit(agentKey, "status", {
        status: "closed",
        text: `remote chat closed after ${idleMs}ms idle`,
      });
    }
    return closed;
  }

  /**
   * Enforce per-host remote ceiling before opening another SSH-backed ACP.
   * Prefer closing the least-recently-touched idle session; refuse if every
   * slot is busy.
   */
  private enforceRemoteCeiling(host: string, openingKey: string): string | undefined {
    if (this.isLocalHost(host)) return undefined;
    const ceiling = maxRemoteSessionsPerHost();
    const peers = [...this.sessions.entries()].filter(
      ([key, session]) =>
        key !== openingKey &&
        session.host === host &&
        !session.client.closed,
    );
    if (peers.length < ceiling) return undefined;

    const idlePeers = peers
      // A handshaking session already owns a child/SSH stream but is not safe
      // to evict until its open settles. It counts toward the ceiling as busy.
      .filter(([, session]) => session.sessionId !== "" && !this.sessionIsBusy(session))
      .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);
    const victim = idlePeers[0];
    if (victim) {
      const [agentKey] = victim;
      this.nextGeneration(agentKey);
      this.closeCurrent(agentKey);
      this.emit(agentKey, "status", {
        status: "closed",
        text: `remote chat closed to enforce the ${host} session ceiling (${ceiling})`,
      });
      return undefined;
    }
    return `remote ACP session ceiling reached for host ${host} (${ceiling} live; all busy) — close a chat or wait for a turn to finish`;
  }

  // Mirrors the fast-path guard in chatOpen: a session counts as "live" only
  // once it has a real sessionId and its ACP child hasn't exited. The kernel
  // uses this to decide whether a pulse can skip straight to sendPrompt or
  // must chatOpen first.
  isLive(agentKey: string): boolean {
    const session = this.sessions.get(agentKey);
    return session !== undefined && !session.client.closed && session.sessionId !== "";
  }

  // True while an ACP permission request from this agent awaits a human
  // answer — feeds the region rollup's attention tier.
  hasPendingPermission(agentKey: string): boolean {
    const session = this.sessions.get(agentKey);
    return session !== undefined && session.pendingPermissions.size > 0;
  }

  private emit(agentKey: string, kind: string, payload: unknown): void {
    try {
      this.eventSink?.({ agentKey, kind, payload });
    } catch {
      // Rendering/event delivery is observational and cannot break session
      // cleanup or prevent a following lifecycle event from being emitted.
    }
  }

  private trackWork<A>(flight: Promise<A>): Promise<A> {
    const tracked = flight.finally(() => this.workFlights.delete(tracked));
    this.workFlights.add(tracked);
    return tracked;
  }

  private closeClient(
    client: AcpClient,
  ): Promise<ReadonlyArray<AcpTeardownResult>> {
    const existing = this.closeByClient.get(client);
    if (existing !== undefined) return existing;
    let closeResult: ReturnType<AcpClient["close"]> | undefined;
    try {
      closeResult = client.close();
    } catch {
      closeResult = undefined;
    }
    const failedReceipt = (): ReadonlyArray<AcpTeardownResult> => [
      { kind: "bounded", termAttempted: false, killAttempted: false },
    ];
    const raw = closeResult === undefined
      ? Promise.resolve(failedReceipt())
      : Promise.resolve(closeResult).then(
          (results) => (Array.isArray(results) ? results : []),
          failedReceipt,
        );
    const flight = raw.then((results) => {
      this.teardownReceipts.push(...results);
      if (results.every((receipt) => receipt.kind === "terminal")) {
        this.clients.delete(client);
      }
      this.clientCloseFlights.delete(flight);
      return results;
    });
    this.closeByClient.set(client, flight);
    this.clientCloseFlights.add(flight);
    return flight;
  }

  private generation(agentKey: string): number {
    return this.generations.get(agentKey) ?? 0;
  }

  private nextGeneration(agentKey: string): number {
    const generation = this.generation(agentKey) + 1;
    this.generations.set(agentKey, generation);
    return generation;
  }

  private isCurrent(agentKey: string, session: AgentSession): boolean {
    return (
      this.generation(agentKey) === session.generation &&
      this.sessions.get(agentKey) === session
    );
  }

  /** In-flight close per agent — second close joins; open waits. */
  private readonly closeFlights = new Map<
    string,
    Promise<ReadonlyArray<AcpTeardownResult>>
  >();
  /**
   * Unclean teardown tombstones: empty-session chatClose must not report clean
   * after a failed verified exit (doctrine: no silent clean-on-retry).
   */
  private readonly uncleanCloses = new Set<string>();

  /**
   * Agent-node delete fence: from delete admission until document commit or
   * abort/timeout. chatOpen refuses the key while tombstoned so a concurrent
   * reopen cannot revive the seat mid-teardown.
   */
  private readonly deleteTombstones = new Map<string, { readonly expiresAt: number }>();
  private static readonly DELETE_TOMBSTONE_TTL_MS = 60_000;

  private isDeleteTombstoned(agentKey: string): boolean {
    const entry = this.deleteTombstones.get(agentKey);
    if (entry === undefined) return false;
    if (Date.now() >= entry.expiresAt) {
      this.deleteTombstones.delete(agentKey);
      return false;
    }
    return true;
  }

  /**
   * Admit a per-agent delete tombstone. Idempotent while already held.
   * chatOpen refuses the key until release (or TTL).
   */
  admitDeleteTombstone(agentKey: string): { readonly ok: true } | { readonly ok: false; readonly error: string } {
    if (this.closing) return { ok: false, error: "chat service is closing" };
    const key = agentKey.trim();
    if (key.length === 0) return { ok: false, error: "invalid agent key" };
    this.deleteTombstones.set(key, {
      expiresAt: Date.now() + ChatService.DELETE_TOMBSTONE_TTL_MS,
    });
    return { ok: true };
  }

  /** Release a delete tombstone after document commit or abort. */
  releaseDeleteTombstone(agentKey: string): void {
    this.deleteTombstones.delete(agentKey.trim());
  }

  private closeCurrent(agentKey: string): Promise<ReadonlyArray<AcpTeardownResult>> {
    const inflight = this.closeFlights.get(agentKey);
    if (inflight !== undefined) return inflight;

    const session = this.sessions.get(agentKey);
    if (session === undefined) {
      // No live session: unclean tombstone stays unclean; genuine no-op is clean.
      return Promise.resolve([]);
    }

    const flight = this.closeClient(session.client).then((receipts) => {
      if (this.sessions.get(agentKey) === session) {
        this.sessions.delete(agentKey);
      }
      const clean =
        receipts.length === 0 ||
        receipts.every((receipt) => receipt.kind === "terminal");
      if (clean) this.uncleanCloses.delete(agentKey);
      else this.uncleanCloses.add(agentKey);
      return receipts;
    });
    const tracked = flight.finally(() => {
      if (this.closeFlights.get(agentKey) === tracked) {
        this.closeFlights.delete(agentKey);
      }
    });
    this.closeFlights.set(agentKey, tracked);
    return tracked;
  }

  private makeSession(
    agentKey: string,
    target: AcpSpawnTarget,
    generation: number,
  ): AgentSession {
    let session: AgentSession;
    const client = new AcpClient(
      target,
      {
        onNotification: (method, params) =>
          this.handleNotification(agentKey, session, method, params),
        onAgentRequest: (method, id, params) =>
          this.handleAgentRequest(agentKey, session, method, id, params),
        onLifecycle: (event) => this.handleLifecycle(agentKey, session, event),
      },
      this.spawnFn,
    );
    this.clients.add(client);
    session = {
      client,
      generation,
      host: target.host,
      sessionId: "",
      models: [],
      promptInFlight: false,
      replyChunks: [],
      pendingPermissions: new Map(),
      lastActivityAt: Date.now(),
    };
    return session;
  }

  private abandonSession(agentKey: string, session: AgentSession): void {
    if (this.sessions.get(agentKey) === session) this.sessions.delete(agentKey);
    void this.closeClient(session.client);
  }

  private supersededOpen(
    agentKey: string,
    session: AgentSession,
  ): ChatOpenResult | undefined {
    if (this.isCurrent(agentKey, session)) return undefined;
    this.abandonSession(agentKey, session);
    return { ok: false, error: "chat open superseded" };
  }

  private async tryResumeSession(
    agentKey: string,
    session: AgentSession,
    resumeSessionId: string,
    cwd: string,
    authSuffix: string,
  ): Promise<ChatOpenResult | undefined> {
    try {
      const result = await session.client.request<SessionResultShape | null>("session/load", {
        sessionId: resumeSessionId,
        cwd,
        mcpServers: [],
      });
      const superseded = this.supersededOpen(agentKey, session);
      if (superseded !== undefined) return superseded;
      if (result === null) return undefined;
      session.sessionId = resumeSessionId;
      session.models = toModelChoices(result);
      this.touch(session);
      return { ok: true, sessionId: resumeSessionId, resumed: true, models: session.models };
    } catch (error) {
      this.abandonSession(agentKey, session);
      return { ok: false, error: `resume failed: ${describeError(error)}${authSuffix}` };
    }
  }

  private beginOpen(
    agentKey: string,
    resumeSessionId?: string,
  ): Promise<ChatOpenResult> {
    if (this.closing) {
      return Promise.resolve({ ok: false, error: "chat service is closing" });
    }
    if (this.isDeleteTombstoned(agentKey)) {
      return Promise.resolve({ ok: false, error: "agent is being deleted" });
    }
    const generation = this.nextGeneration(agentKey);
    const promise = this.trackWork(this.openFresh(
      agentKey,
      generation,
      resumeSessionId,
    )
      .finally(() => {
        const current = this.openInFlight.get(agentKey);
        if (current?.generation === generation) this.openInFlight.delete(agentKey);
      }));
    this.openInFlight.set(agentKey, { generation, promise });
    return promise;
  }

  // Idempotent per key: a second chatOpen for an already-live session
  // returns its current state rather than respawning. The sessionId !== ""
  // guard matters: openFresh registers the session in `sessions` (with
  // sessionId "") synchronously, before it awaits the handshake — so a
  // second chatOpen racing an in-flight first one must NOT take this fast
  // path (it would return ok:true with an empty, unusable sessionId). It
  // falls through to the openInFlight check below instead and joins the
  // same in-flight open.
  async chatOpen(
    agentKey: string,
    resumeSessionId?: string,
  ): Promise<ChatOpenResult> {
    if (this.closing) return { ok: false, error: "chat service is closing" };
    if (this.isDeleteTombstoned(agentKey)) {
      return { ok: false, error: "agent is being deleted" };
    }
    // Never open a replacement seat while close/teardown is in flight.
    const closing = this.closeFlights.get(agentKey);
    if (closing !== undefined) await closing;
    // Re-check after awaiting close — delete may have been admitted meanwhile.
    if (this.isDeleteTombstoned(agentKey)) {
      return { ok: false, error: "agent is being deleted" };
    }
    const existing = this.sessions.get(agentKey);
    if (existing && !existing.client.closed && existing.sessionId !== "") {
      this.touch(existing);
      return { ok: true, sessionId: existing.sessionId, resumed: false, models: existing.models };
    }

    const inFlight = this.openInFlight.get(agentKey);
    if (inFlight) return inFlight.promise;

    const opened = await this.beginOpen(agentKey, resumeSessionId);
    if (opened.ok) this.uncleanCloses.delete(agentKey);
    return opened;
  }

  private async openFresh(
    agentKey: string,
    generation: number,
    resumeSessionId?: string,
  ): Promise<ChatOpenResult> {
    if (this.closing) return { ok: false, error: "chat service is closing" };
    if (this.isDeleteTombstoned(agentKey)) {
      return { ok: false, error: "agent is being deleted" };
    }
    const target = buildAcpSpawnTarget(agentKey);
    if (!target) return { ok: false, error: `invalid agent key: ${agentKey}` };
    if (this.generation(agentKey) !== generation) {
      return { ok: false, error: "chat open superseded" };
    }

    // Sweep before counting so idle slots free up for a new open.
    this.evictIdleSessions();
    const ceilingError = this.enforceRemoteCeiling(target.host, agentKey);
    if (ceilingError !== undefined) return { ok: false, error: ceilingError };

    const session = this.makeSession(agentKey, target, generation);
    this.sessions.set(agentKey, session);

    // Populated once initialize succeeds; describeAuthMethods("") is a no-op
    // suffix if it never gets set (e.g. initialize itself failed).
    let authSuffix = "";
    try {
      const init = await session.client.start();
      const supersededAfterStart = this.supersededOpen(agentKey, session);
      if (supersededAfterStart !== undefined) return supersededAfterStart;
      authSuffix = describeAuthMethods(init.authMethods);
      const cwd = resolveSessionCwd(this.isLocalHost(target.host));

      if (resumeSessionId) {
        const resumed = await this.tryResumeSession(
          agentKey,
          session,
          resumeSessionId,
          cwd,
          authSuffix,
        );
        // A null session/load result means the session no longer exists on
        // the agent side, so fall through to a fresh session/new.
        if (resumed !== undefined) return resumed;
      }

      const created = await session.client.request<SessionResultShape>("session/new", { cwd, mcpServers: [] });
      const supersededAfterCreate = this.supersededOpen(agentKey, session);
      if (supersededAfterCreate !== undefined) return supersededAfterCreate;
      if (!created.sessionId) throw new Error("session/new returned no sessionId");
      session.sessionId = created.sessionId;
      session.models = toModelChoices(created);
      this.touch(session);
      return { ok: true, sessionId: session.sessionId, resumed: false, models: session.models };
    } catch (err) {
      this.abandonSession(agentKey, session);
      return { ok: false, error: `${describeError(err)}${authSuffix}` };
    }
  }

  private async runPrompt(
    agentKey: string,
    text: string,
    contextBlocks?: ReadonlyArray<string>,
  ): Promise<{ readonly turn: ChatTurnResult; readonly reply: string }> {
    if (this.closing) {
      return { turn: { ok: false, error: "chat service is closing" }, reply: "" };
    }
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) {
      return {
        turn: { ok: false, error: "chat session not open — call chatOpen first" },
        reply: "",
      };
    }
    if (session.promptInFlight) {
      return { turn: { ok: false, error: "turn in flight" }, reply: "" };
    }

    const blocks = [
      { type: "text", text },
      ...(contextBlocks ?? []).map((block) => ({ type: "text", text: block })),
    ];

    session.promptInFlight = true;
    session.replyChunks = [];
    this.touch(session);
    try {
      const result = await session.client.request<{ stopReason?: string }>("session/prompt", {
        sessionId: session.sessionId,
        prompt: blocks,
      });
      if (!this.isCurrent(agentKey, session) || this.closing) {
        return { turn: { ok: false, error: "chat session closed" }, reply: "" };
      }
      this.touch(session);
      return {
        turn: { ok: true, stopReason: result.stopReason },
        reply: session.replyChunks.join(""),
      };
    } catch (err) {
      return { turn: { ok: false, error: describeError(err) }, reply: "" };
    } finally {
      session.promptInFlight = false;
    }
  }

  async chatPrompt(
    agentKey: string,
    text: string,
    contextBlocks?: ReadonlyArray<string>,
  ): Promise<ChatTurnResult> {
    if (this.closing) return { ok: false, error: "chat service is closing" };
    return (await this.trackWork(this.runPrompt(agentKey, text, contextBlocks))).turn;
  }

  agentMessage(agentKey: string, text: string): Promise<AgentReply> {
    if (this.closing) {
      return Promise.resolve({ ok: false, error: "chat service is closing" });
    }
    return this.trackWork(this.agentMessageOperation(agentKey, text));
  }

  private async agentMessageOperation(agentKey: string, text: string): Promise<AgentReply> {
    if (text.trim().length === 0) return { ok: false, error: "empty message" };
    const opened = await this.chatOpen(agentKey);
    if (!opened.ok) return opened;
    if (this.closing) return { ok: false, error: "chat service is closing" };
    const result = await this.runPrompt(agentKey, text);
    return result.turn.ok
      ? { ok: true, reply: result.reply }
      : { ok: false, error: result.turn.error };
  }

  async chatPermission(agentKey: string, requestId: string, optionId: string): Promise<{ ok: boolean }> {
    if (this.closing) return { ok: false };
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false };
    const id = session.pendingPermissions.get(requestId);
    if (id === undefined) return { ok: false };
    session.pendingPermissions.delete(requestId);
    session.client.respond(id, { outcome: { outcome: "selected", optionId } });
    this.touch(session);
    return { ok: true };
  }

  chatSetModel(agentKey: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.closing) {
      return Promise.resolve({ ok: false, error: "chat service is closing" });
    }
    return this.trackWork(this.chatSetModelOperation(agentKey, modelId));
  }

  private async chatSetModelOperation(
    agentKey: string,
    modelId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false, error: "chat session not open" };
    this.touch(session);
    try {
      await session.client.request("session/set_model", { modelId, sessionId: session.sessionId });
      if (!this.isCurrent(agentKey, session) || this.closing) {
        return { ok: false, error: "chat session closed" };
      }
      this.touch(session);
      return { ok: true };
    } catch (err) {
      if (err instanceof AcpRpcError && err.code === -32601) {
        return { ok: false, error: "unsupported" };
      }
      return { ok: false, error: describeError(err) };
    }
  }

  async chatClose(agentKey: string): Promise<{ ok: boolean; clean: boolean }> {
    this.nextGeneration(agentKey);
    const hadSession = this.sessions.has(agentKey);
    const hadFlight = this.closeFlights.has(agentKey);
    // True no-op: no session, no in-flight close. Unclean tombstone must not
    // become clean-on-retry (doctrine: verified exit).
    if (!hadSession && !hadFlight) {
      if (this.uncleanCloses.has(agentKey)) {
        return { ok: false, clean: false };
      }
      return { ok: true, clean: true };
    }
    const receipts = await this.closeCurrent(agentKey);
    // Empty receipt list is clean (nothing left to tear down after a settled
    // close). Non-empty requires every receipt kind === "terminal".
    const clean = receipts.every((receipt) => receipt.kind === "terminal");
    if (clean) this.uncleanCloses.delete(agentKey);
    else this.uncleanCloses.add(agentKey);
    return { ok: clean, clean };
  }

  closeAll(): Promise<ChatCloseAllResult> {
    if (this.closeAllFlight !== undefined) return this.closeAllFlight;
    this.closing = true;
    this.stopIdleSweep();
    this.unsubscribeHostsSnapshot?.();
    this.unsubscribeHostsSnapshot = undefined;
    const keys = new Set([
      ...this.sessions.keys(),
      ...this.openInFlight.keys(),
    ]);
    for (const key of keys) {
      this.nextGeneration(key);
      void this.closeCurrent(key);
    }
    for (const client of [...this.clients]) void this.closeClient(client);

    this.closeAllFlight = (async (): Promise<ChatCloseAllResult> => {
      while (true) {
        for (const client of [...this.clients]) void this.closeClient(client);
        const flights = new Set<Promise<unknown>>([
          ...this.workFlights,
          ...this.clientCloseFlights,
          ...[...this.openInFlight.values()].map((entry) => entry.promise),
        ]);
        if (flights.size === 0) break;
        await Promise.allSettled(flights);
      }
      const teardowns = [...this.teardownReceipts];
      return {
        clean: teardowns.every((receipt) => receipt.kind === "terminal"),
        teardowns,
      };
    })();
    return this.closeAllFlight;
  }

  // --- ACP -> ChatEvent projection ------------------------------------------

  private handleNotification(
    agentKey: string,
    session: AgentSession,
    method: string,
    params: unknown,
  ): void {
    if (!this.isCurrent(agentKey, session)) return;
    if (method !== "session/update") {
      console.debug(`[chat:${agentKey}] unhandled ACP notification`, method);
      return;
    }
    const update = (params as { update?: { sessionUpdate?: string } } | undefined)?.update;
    if (!update) return;
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = (update as { readonly content?: { readonly text?: unknown } }).content?.text;
      if (typeof text === "string") session.replyChunks.push(text);
    }
    this.emit(agentKey, update.sessionUpdate ?? "update", update);
  }

  private handleAgentRequest(
    agentKey: string,
    session: AgentSession,
    method: string,
    id: JsonRpcId,
    params: unknown,
  ): void {
    if (!this.isCurrent(agentKey, session)) return;

    if (method === "session/request_permission") {
      const requestId = String(id);
      session.pendingPermissions.set(requestId, id);
      this.touch(session);
      this.emit(agentKey, "permission_request", { requestId, ...(params as object) });
      return;
    }

    // Unknown agent -> client request: reject per the ACP wire contract
    // rather than leaving the agent's call hanging.
    session.client.respondError(id, -32601, `method not found: ${method}`);
  }

  private handleLifecycle(
    agentKey: string,
    session: AgentSession,
    event: AcpLifecycleEvent,
  ): void {
    if (!this.isCurrent(agentKey, session)) return;
    this.sessions.delete(agentKey);
    void this.closeClient(session.client);
    const message = event.kind === "error" ? event.message : `agent process exited (code ${event.code ?? "unknown"})`;
    this.emit(agentKey, "error", { message });
    this.emit(agentKey, "status", { status: "closed" });
  }
}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/ChatService` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class ChatServiceContext extends Context.Service<ChatServiceContext, ChatService>()("@vellum/ChatService") {}`
 * - Layer today: ChatServiceFromHermesLive (hermes plane) — single id; class name is Context holder only
 *   Do not dual-export Live + `.layer` names.
 */
export class ChatServiceContext extends Context.Service<ChatServiceContext,
  ChatService>()("@vellum/ChatService") {}
