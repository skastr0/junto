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
  makeLocalBrowserChildEnvironment,
  type AcpChildEnvironmentOverlay,
  type AcpLifecycleEvent,
  type JsonRpcId,
  type LocalBrowserChildEnvironmentInput,
  type SpawnFn,
} from "./acp-client";
import { buildAcpSpawnTarget, resolveSessionCwd, type AcpSpawnTarget } from "./spawn";
import { getProcessIdentityMap } from "../process-identity";

// One live ACP session per agent node ("<host>:<profile>"). ChatService owns
// spawn/initialize/session lifecycle and the ACP <-> ChatEvent projection;
// the IPC layer (chat/ipc.ts, wired by the orchestrator) is a thin
// pass-through onto this class.
//
// Local ACP children are process-bound: their OS pid is registered so work
// and browser control can admit the agent without a forgeable nodeRef claim.

interface AgentSession {
  readonly client: AcpClient;
  readonly generation: number;
  /** Hermes host id from the agent key (local | configured remote). */
  readonly host: string;
  /** Local child pid registered for process-bind (undefined when remote). */
  boundPid?: number;
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

const isRemoteHost = (host: string): boolean => host !== "local";

const remoteHermesRoutes = (
  hosts: ReadonlyArray<RemoteHost>,
): ReadonlyMap<string, string> =>
  new Map(
    hosts
      .filter(
        (host) =>
          host.kind === "remote" &&
          host.endpoint !== undefined &&
          hostHasCapability(host, "hermes"),
      )
      .map((host) => [hermesKeyFor(host), host.endpoint!] as const),
  );

interface OpenInFlight {
  readonly generation: number;
  readonly promise: Promise<ChatOpenResult>;
}

export type ChatEnvironmentChangeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

interface RawModelInfo {
  readonly modelId?: string;
  readonly description?: string;
}

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
  private readonly authorityRestartInFlight = new Map<string, Promise<ChatOpenResult>>();
  private readonly generations = new Map<string, number>();
  private eventSink: ((event: ChatEvent) => void) | undefined;
  /** Fires when a session is live (new open or already-open fast path). */
  private sessionLiveHook: ((agentKey: string) => void) | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeHostsSnapshot: (() => void) | undefined;

  constructor(private readonly spawnFn: SpawnFn) {
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

  /** Optional live-session hook — message delivery retries pending nudges here. */
  setSessionLiveHook(hook: ((agentKey: string) => void) | undefined): void {
    this.sessionLiveHook = hook;
  }

  private notifySessionLive(agentKey: string): void {
    try {
      this.sessionLiveHook?.(agentKey);
    } catch {
      // Hook must never sink chat open.
    }
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
      if (!isRemoteHost(session.host) || !changedHosts.has(session.host)) continue;
      this.nextGeneration(agentKey);
      this.closeCurrent(agentKey);
      this.emit(agentKey, "status", {
        status: "closed",
        text: `remote chat closed because host ${session.host} routing changed`,
      });
    }
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
      if (!isRemoteHost(session.host)) continue;
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
    if (!isRemoteHost(host)) return undefined;
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
    this.eventSink?.({ agentKey, kind, payload });
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

  private bindLocalProcess(agentKey: string, session: AgentSession): void {
    if (session.host !== "local") return;
    const pid = session.client.childPid;
    if (pid === undefined) return;
    session.boundPid = pid;
    getProcessIdentityMap().bind(pid, { kind: "agent", agentKey });
  }

  private unbindLocalProcess(session: AgentSession | undefined): void {
    if (session?.boundPid === undefined) return;
    getProcessIdentityMap().unbind(session.boundPid);
    session.boundPid = undefined;
  }

  private closeCurrent(agentKey: string): void {
    const session = this.sessions.get(agentKey);
    if (session === undefined) return;
    this.unbindLocalProcess(session);
    if (this.sessions.get(agentKey) === session) this.sessions.delete(agentKey);
    session.client.close();
  }

  private makeSession(
    agentKey: string,
    target: AcpSpawnTarget,
    generation: number,
    environmentOverlay?: AcpChildEnvironmentOverlay,
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
      environmentOverlay,
    );
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
    this.unbindLocalProcess(session);
    if (this.sessions.get(agentKey) === session) this.sessions.delete(agentKey);
    session.client.close();
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
    environmentOverlay?: AcpChildEnvironmentOverlay,
    generation = this.nextGeneration(agentKey),
  ): Promise<ChatOpenResult> {
    const promise = this.openFresh(
      agentKey,
      generation,
      resumeSessionId,
      environmentOverlay,
    )
      .then((result) => {
        if (result.ok) this.notifySessionLive(agentKey);
        return result;
      })
      .finally(() => {
        const current = this.openInFlight.get(agentKey);
        if (current?.generation === generation) this.openInFlight.delete(agentKey);
      });
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
  async chatOpen(agentKey: string, resumeSessionId?: string): Promise<ChatOpenResult> {
    const authorityRestart = this.authorityRestartInFlight.get(agentKey);
    if (authorityRestart !== undefined) return authorityRestart;
    const existing = this.sessions.get(agentKey);
    if (existing && !existing.client.closed && existing.sessionId !== "") {
      this.touch(existing);
      this.notifySessionLive(agentKey);
      return { ok: true, sessionId: existing.sessionId, resumed: false, models: existing.models };
    }

    const inFlight = this.openInFlight.get(agentKey);
    if (inFlight) return inFlight.promise;

    return this.beginOpen(agentKey, resumeSessionId);
  }

  async chatOpenWithLocalBrowserAuthority(
    agentKey: string,
    environment: LocalBrowserChildEnvironmentInput,
    resumeSessionId?: string,
  ): Promise<ChatOpenResult> {
    const target = buildAcpSpawnTarget(agentKey);
    if (target === undefined) return { ok: false, error: `invalid agent key: ${agentKey}` };
    if (target.host !== "local") {
      return { ok: false, error: "browser authority child environment is local-only" };
    }
    let overlay: AcpChildEnvironmentOverlay;
    try {
      overlay = makeLocalBrowserChildEnvironment(environment);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
    if (
      this.sessions.has(agentKey) ||
      this.openInFlight.has(agentKey) ||
      this.authorityRestartInFlight.has(agentKey)
    ) {
      return {
        ok: false,
        error: "chat session already open or opening — use deliberate authority restart",
      };
    }
    return this.beginOpen(agentKey, resumeSessionId, overlay);
  }

  async chatRestartWithLocalBrowserAuthority(
    agentKey: string,
    environment: LocalBrowserChildEnvironmentInput,
    resumeSessionId?: string,
  ): Promise<ChatOpenResult> {
    const target = buildAcpSpawnTarget(agentKey);
    if (target === undefined) return { ok: false, error: `invalid agent key: ${agentKey}` };
    if (target.host !== "local") {
      return { ok: false, error: "browser authority child environment is local-only" };
    }
    if (this.authorityRestartInFlight.has(agentKey)) {
      return { ok: false, error: "authority restart already in flight" };
    }
    let overlay: AcpChildEnvironmentOverlay;
    try {
      overlay = makeLocalBrowserChildEnvironment(environment);
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }

    const current = this.sessions.get(agentKey);
    const effectiveResumeSessionId =
      resumeSessionId ??
      (current !== undefined && !current.client.closed && current.sessionId !== ""
        ? current.sessionId
        : undefined);
    const previousOpen = this.openInFlight.get(agentKey);
    const generation = this.nextGeneration(agentKey);
    this.closeCurrent(agentKey);
    const restart = (async (): Promise<ChatOpenResult> => {
      if (previousOpen !== undefined) await previousOpen.promise;
      if (this.generation(agentKey) !== generation) {
        return { ok: false, error: "authority restart superseded" };
      }
      return this.beginOpen(agentKey, effectiveResumeSessionId, overlay, generation);
    })().finally(() => {
      if (this.authorityRestartInFlight.get(agentKey) === restart) {
        this.authorityRestartInFlight.delete(agentKey);
      }
    });
    this.authorityRestartInFlight.set(agentKey, restart);
    return restart;
  }

  async chatRevokeLocalBrowserAuthority(
    agentKey: string,
  ): Promise<ChatEnvironmentChangeResult> {
    const target = buildAcpSpawnTarget(agentKey);
    if (target === undefined) return { ok: false, error: `invalid agent key: ${agentKey}` };
    if (target.host !== "local") {
      return { ok: false, error: "browser authority child environment is local-only" };
    }
    this.nextGeneration(agentKey);
    this.closeCurrent(agentKey);
    return { ok: true };
  }

  private async openFresh(
    agentKey: string,
    generation: number,
    resumeSessionId?: string,
    environmentOverlay?: AcpChildEnvironmentOverlay,
  ): Promise<ChatOpenResult> {
    const target = buildAcpSpawnTarget(agentKey);
    if (!target) return { ok: false, error: `invalid agent key: ${agentKey}` };
    if (this.generation(agentKey) !== generation) {
      return { ok: false, error: "chat open superseded" };
    }

    // Sweep before counting so idle slots free up for a new open.
    this.evictIdleSessions();
    const ceilingError = this.enforceRemoteCeiling(target.host, agentKey);
    if (ceilingError !== undefined) return { ok: false, error: ceilingError };

    const session = this.makeSession(agentKey, target, generation, environmentOverlay);
    this.sessions.set(agentKey, session);

    // Populated once initialize succeeds; describeAuthMethods("") is a no-op
    // suffix if it never gets set (e.g. initialize itself failed).
    let authSuffix = "";
    try {
      const init = await session.client.start();
      const supersededAfterStart = this.supersededOpen(agentKey, session);
      if (supersededAfterStart !== undefined) return supersededAfterStart;
      // Process-bind local ACP children so work/browser CLIs admit by peer PID.
      this.bindLocalProcess(agentKey, session);
      authSuffix = describeAuthMethods(init.authMethods);
      const cwd = resolveSessionCwd(target.host);

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
      this.touch(session);
      return {
        turn: { ok: true, stopReason: result.stopReason },
        reply: session.replyChunks.join(""),
      };
    } catch (err) {
      return { turn: { ok: false, error: describeError(err) }, reply: "" };
    } finally {
      session.promptInFlight = false;
      // Transport re-available for pending message nudges (idle re-drive).
      // Does not re-open chat; only notifies listeners that the turn slot is free.
      this.notifySessionLive(agentKey);
    }
  }

  async chatPrompt(
    agentKey: string,
    text: string,
    contextBlocks?: ReadonlyArray<string>,
  ): Promise<ChatTurnResult> {
    return (await this.runPrompt(agentKey, text, contextBlocks)).turn;
  }

  async agentMessage(agentKey: string, text: string): Promise<AgentReply> {
    if (text.trim().length === 0) return { ok: false, error: "empty message" };
    const opened = await this.chatOpen(agentKey);
    if (!opened.ok) return opened;
    const result = await this.runPrompt(agentKey, text);
    return result.turn.ok
      ? { ok: true, reply: result.reply }
      : { ok: false, error: result.turn.error };
  }

  async chatPermission(agentKey: string, requestId: string, optionId: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false };
    const id = session.pendingPermissions.get(requestId);
    if (id === undefined) return { ok: false };
    session.pendingPermissions.delete(requestId);
    session.client.respond(id, { outcome: { outcome: "selected", optionId } });
    this.touch(session);
    return { ok: true };
  }

  async chatSetModel(agentKey: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false, error: "chat session not open" };
    this.touch(session);
    try {
      await session.client.request("session/set_model", { modelId, sessionId: session.sessionId });
      this.touch(session);
      return { ok: true };
    } catch (err) {
      if (err instanceof AcpRpcError && err.code === -32601) {
        return { ok: false, error: "unsupported" };
      }
      return { ok: false, error: describeError(err) };
    }
  }

  async chatClose(agentKey: string): Promise<{ ok: boolean }> {
    this.nextGeneration(agentKey);
    this.closeCurrent(agentKey);
    return { ok: true };
  }

  closeAll(): void {
    this.stopIdleSweep();
    this.unsubscribeHostsSnapshot?.();
    this.unsubscribeHostsSnapshot = undefined;
    const keys = new Set([
      ...this.sessions.keys(),
      ...this.openInFlight.keys(),
      ...this.authorityRestartInFlight.keys(),
    ]);
    for (const key of keys) {
      this.nextGeneration(key);
      this.closeCurrent(key);
    }
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
    this.unbindLocalProcess(session);
    this.sessions.delete(agentKey);
    const message = event.kind === "error" ? event.message : `agent process exited (code ${event.code ?? "unknown"})`;
    this.emit(agentKey, "error", { message });
    this.emit(agentKey, "status", { status: "closed" });
  }
}

export class ChatServiceContext extends Context.Tag("@vellum/ChatService")<
  ChatServiceContext,
  ChatService
>() {}
