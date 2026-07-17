import type { ChatEvent, ChatModelChoice, ChatOpenResult, ChatTurnResult } from "@shared/ipc";
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

// One live ACP session per agent node ("<host>:<profile>"). ChatService owns
// spawn/initialize/session lifecycle and the ACP <-> ChatEvent projection;
// the IPC layer (chat/ipc.ts, wired by the orchestrator) is a thin
// pass-through onto this class.

interface AgentSession {
  readonly client: AcpClient;
  readonly generation: number;
  sessionId: string;
  models: ReadonlyArray<ChatModelChoice>;
  promptInFlight: boolean;
  // requestId (stringified JSON-RPC id) -> the original id, so a later
  // chatPermission call can echo it back to the agent unchanged.
  readonly pendingPermissions: Map<string, JsonRpcId>;
}

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

  // spawnFn is injectable for tests (a fake child instead of a real
  // `hermes acp` process); production callers construct with no argument.
  constructor(private readonly spawnFn?: SpawnFn) {}

  setEventSink(sink: (event: ChatEvent) => void): void {
    this.eventSink = sink;
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

  private closeCurrent(agentKey: string): void {
    const session = this.sessions.get(agentKey);
    if (session === undefined) return;
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
      sessionId: "",
      models: [],
      promptInFlight: false,
      pendingPermissions: new Map(),
    };
    return session;
  }

  private abandonSession(agentKey: string, session: AgentSession): void {
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
    ).finally(() => {
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

    const previousOpen = this.openInFlight.get(agentKey);
    const generation = this.nextGeneration(agentKey);
    this.closeCurrent(agentKey);
    const restart = (async (): Promise<ChatOpenResult> => {
      if (previousOpen !== undefined) await previousOpen.promise;
      if (this.generation(agentKey) !== generation) {
        return { ok: false, error: "authority restart superseded" };
      }
      return this.beginOpen(agentKey, resumeSessionId, overlay, generation);
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

    const session = this.makeSession(agentKey, target, generation, environmentOverlay);
    this.sessions.set(agentKey, session);

    // Populated once initialize succeeds; describeAuthMethods("") is a no-op
    // suffix if it never gets set (e.g. initialize itself failed).
    let authSuffix = "";
    try {
      const init = await session.client.start();
      const supersededAfterStart = this.supersededOpen(agentKey, session);
      if (supersededAfterStart !== undefined) return supersededAfterStart;
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
      return { ok: true, sessionId: session.sessionId, resumed: false, models: session.models };
    } catch (err) {
      this.abandonSession(agentKey, session);
      return { ok: false, error: `${describeError(err)}${authSuffix}` };
    }
  }

  async chatPrompt(
    agentKey: string,
    text: string,
    contextBlocks?: ReadonlyArray<string>,
  ): Promise<ChatTurnResult> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) {
      return { ok: false, error: "chat session not open — call chatOpen first" };
    }
    if (session.promptInFlight) {
      return { ok: false, error: "turn in flight" };
    }

    const blocks = [
      { type: "text", text },
      ...(contextBlocks ?? []).map((block) => ({ type: "text", text: block })),
    ];

    session.promptInFlight = true;
    try {
      const result = await session.client.request<{ stopReason?: string }>("session/prompt", {
        sessionId: session.sessionId,
        prompt: blocks,
      });
      return { ok: true, stopReason: result.stopReason };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      session.promptInFlight = false;
    }
  }

  async chatPermission(agentKey: string, requestId: string, optionId: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false };
    const id = session.pendingPermissions.get(requestId);
    if (id === undefined) return { ok: false };
    session.pendingPermissions.delete(requestId);
    session.client.respond(id, { outcome: { outcome: "selected", optionId } });
    return { ok: true };
  }

  async chatSetModel(agentKey: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    const session = this.sessions.get(agentKey);
    if (!session || session.client.closed) return { ok: false, error: "chat session not open" };
    try {
      await session.client.request("session/set_model", { modelId, sessionId: session.sessionId });
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
    const message = event.kind === "error" ? event.message : `agent process exited (code ${event.code ?? "unknown"})`;
    this.emit(agentKey, "error", { message });
    this.emit(agentKey, "status", { status: "closed" });
  }
}
