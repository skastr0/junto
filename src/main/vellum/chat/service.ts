import type { ChatEvent, ChatModelChoice, ChatOpenResult, ChatTurnResult } from "@shared/ipc";
import { AcpClient, AcpRpcError, type AcpLifecycleEvent, type JsonRpcId, type SpawnFn } from "./acp-client";
import { buildAcpSpawnTarget, resolveSessionCwd } from "./spawn";

// One live ACP session per agent node ("<host>:<profile>"). ChatService owns
// spawn/initialize/session lifecycle and the ACP <-> ChatEvent projection;
// the IPC layer (chat/ipc.ts, wired by the orchestrator) is a thin
// pass-through onto this class.

interface AgentSession {
  readonly client: AcpClient;
  sessionId: string;
  models: ReadonlyArray<ChatModelChoice>;
  promptInFlight: boolean;
  // requestId (stringified JSON-RPC id) -> the original id, so a later
  // chatPermission call can echo it back to the agent unchanged.
  readonly pendingPermissions: Map<string, JsonRpcId>;
}

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
  private readonly openInFlight = new Map<string, Promise<ChatOpenResult>>();
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

  private emit(agentKey: string, kind: string, payload: unknown): void {
    this.eventSink?.({ agentKey, kind, payload });
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
    const existing = this.sessions.get(agentKey);
    if (existing && !existing.client.closed && existing.sessionId !== "") {
      return { ok: true, sessionId: existing.sessionId, resumed: false, models: existing.models };
    }

    const inFlight = this.openInFlight.get(agentKey);
    if (inFlight) return inFlight;

    const promise = this.openFresh(agentKey, resumeSessionId).finally(() => {
      this.openInFlight.delete(agentKey);
    });
    this.openInFlight.set(agentKey, promise);
    return promise;
  }

  private async openFresh(agentKey: string, resumeSessionId?: string): Promise<ChatOpenResult> {
    const target = buildAcpSpawnTarget(agentKey);
    if (!target) return { ok: false, error: `invalid agent key: ${agentKey}` };

    const session: AgentSession = {
      client: new AcpClient(
        target,
        {
          onNotification: (method, params) => this.handleNotification(agentKey, method, params),
          onAgentRequest: (method, id, params) => this.handleAgentRequest(agentKey, method, id, params),
          onLifecycle: (event) => this.handleLifecycle(agentKey, event),
        },
        this.spawnFn,
      ),
      sessionId: "",
      models: [],
      promptInFlight: false,
      pendingPermissions: new Map(),
    };
    this.sessions.set(agentKey, session);

    // Populated once initialize succeeds; describeAuthMethods("") is a no-op
    // suffix if it never gets set (e.g. initialize itself failed).
    let authSuffix = "";
    try {
      const init = await session.client.start();
      authSuffix = describeAuthMethods(init.authMethods);
      const cwd = resolveSessionCwd(target.host);

      if (resumeSessionId) {
        try {
          const result = await session.client.request<SessionResultShape | null>("session/load", {
            sessionId: resumeSessionId,
            cwd,
            mcpServers: [],
          });
          if (result) {
            session.sessionId = resumeSessionId;
            session.models = toModelChoices(result);
            return { ok: true, sessionId: resumeSessionId, resumed: true, models: session.models };
          }
          // session/load answered but the session no longer exists on the
          // agent side — fall through to a fresh session/new below rather
          // than hard-failing chatOpen.
        } catch (err) {
          this.sessions.delete(agentKey);
          session.client.close();
          return { ok: false, error: `resume failed: ${describeError(err)}${authSuffix}` };
        }
      }

      const created = await session.client.request<SessionResultShape>("session/new", { cwd, mcpServers: [] });
      if (!created.sessionId) throw new Error("session/new returned no sessionId");
      session.sessionId = created.sessionId;
      session.models = toModelChoices(created);
      return { ok: true, sessionId: session.sessionId, resumed: false, models: session.models };
    } catch (err) {
      this.sessions.delete(agentKey);
      session.client.close();
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
    const session = this.sessions.get(agentKey);
    if (!session) return { ok: true };
    this.sessions.delete(agentKey);
    session.client.close();
    return { ok: true };
  }

  // --- ACP -> ChatEvent projection ------------------------------------------

  private handleNotification(agentKey: string, method: string, params: unknown): void {
    if (method !== "session/update") {
      console.debug(`[chat:${agentKey}] unhandled ACP notification`, method);
      return;
    }
    const update = (params as { update?: { sessionUpdate?: string } } | undefined)?.update;
    if (!update) return;
    this.emit(agentKey, update.sessionUpdate ?? "update", update);
  }

  private handleAgentRequest(agentKey: string, method: string, id: JsonRpcId, params: unknown): void {
    const session = this.sessions.get(agentKey);
    if (!session) return;

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

  private handleLifecycle(agentKey: string, event: AcpLifecycleEvent): void {
    this.sessions.delete(agentKey);
    const message = event.kind === "error" ? event.message : `agent process exited (code ${event.code ?? "unknown"})`;
    this.emit(agentKey, "error", { message });
    this.emit(agentKey, "status", { status: "closed" });
  }
}
