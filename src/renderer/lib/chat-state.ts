import { observable } from "@legendapp/state";
import { ulid } from "ulid";
import type { ChatApi, ChatEvent, ChatModelChoice, ChatOpenResult } from "@shared/ipc";
import { getVellumApi } from "./vellum-api";

// window.vellum is ambiently typed as VellumApi only (src/renderer/global.d.ts).
// The ACP chat surface (ChatApi) is documented as "merged into the preload
// bridge alongside VellumApi" at runtime, but that global declaration isn't
// ours to widen (out of this file's lane) — so this module reads the chat
// methods off the same object through a local cast. Every call site below
// still gates on `typeof x === "function"` before calling, so an
// over-optimistic type costs nothing: a method that isn't actually there yet
// degrades to a quiet error state exactly like a genuinely absent one would.
const getChatApi = (): ChatApi | undefined => getVellumApi() as unknown as ChatApi | undefined;

// One live ACP session per agent node, keyed by agentKey ("<host>:<profile>").
// ChatEvent payloads are forwarded verbatim from the ACP relay (see
// @shared/ipc's comment on ChatEvent) — every read below narrows `unknown`
// defensively. A payload that doesn't match the expected shape degrades to
// "ignore this field" rather than throwing; a missing window.vellum method
// degrades to a quiet error state. Nothing in this module ever throws across
// its public surface.

export type ChatStatus = "idle" | "connecting" | "live" | "closed" | "error";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
const TOOL_STATUSES: ReadonlyArray<ToolStatus> = ["pending", "in_progress", "completed", "failed"];

export interface ChatUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface ChatPlanEntry {
  readonly content: string;
  readonly status: string;
  readonly priority?: string;
}

export interface ChatPermissionOption {
  readonly optionId: string;
  readonly label: string;
}

interface ChatItemBase {
  readonly id: string;
  // Named ts, not at — Legend State's ObservableArray type reserves `.at()`
  // (Array.prototype.at) and a field literally named `at` collides with it.
  readonly ts: number;
}

export interface ChatUserItem extends ChatItemBase {
  readonly kind: "user";
  readonly text: string;
}

export interface ChatAssistantItem extends ChatItemBase {
  readonly kind: "assistant";
  readonly text: string;
}

export interface ChatThoughtItem extends ChatItemBase {
  readonly kind: "thought";
  readonly text: string;
}

export interface ChatToolItem extends ChatItemBase {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly title: string;
  readonly status: ToolStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly contentText?: string;
}

export interface ChatPlanItem extends ChatItemBase {
  readonly kind: "plan";
  readonly entries: ReadonlyArray<ChatPlanEntry>;
}

export interface ChatPermissionItem extends ChatItemBase {
  readonly kind: "permission";
  readonly requestId: string;
  readonly title: string;
  readonly toolKind?: string;
  readonly options: ReadonlyArray<ChatPermissionOption>;
  readonly answeredOptionId?: string;
}

export interface ChatStatusItem extends ChatItemBase {
  readonly kind: "status";
  readonly text: string;
  readonly level: "info" | "error";
}

export type ChatItem =
  | ChatUserItem
  | ChatAssistantItem
  | ChatThoughtItem
  | ChatToolItem
  | ChatPlanItem
  | ChatPermissionItem
  | ChatStatusItem;

export interface AgentChatState {
  readonly status: ChatStatus;
  readonly sessionId?: string;
  readonly models: ReadonlyArray<ChatModelChoice>;
  readonly selectedModelId?: string;
  readonly transcript: ReadonlyArray<ChatItem>;
  readonly pendingPermission?: { readonly requestId: string };
  readonly usage?: ChatUsage;
  readonly unread: number;
  readonly error?: string;
  readonly authMethods?: ReadonlyArray<string>;
  /** True while chatPrompt awaits the full turn (tools may not have arrived yet). */
  readonly turnBusy: boolean;
}

export const initialAgentChatState = (): AgentChatState => ({
  status: "idle",
  models: [],
  transcript: [],
  unread: 0,
  turnBusy: false,
});

// --- defensive payload narrowing --------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.map((block) => extractContentText(block)).filter((text): text is string => typeof text === "string");
    return texts.length > 0 ? texts.join("") : undefined;
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return undefined;
}

function extractChunkText(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return extractContentText(payload.content);
}

function normalizeToolStatus(value: unknown): ToolStatus | undefined {
  return typeof value === "string" && (TOOL_STATUSES as ReadonlyArray<string>).includes(value) ? (value as ToolStatus) : undefined;
}

interface ToolInfo {
  readonly toolCallId?: string;
  readonly title?: string;
  readonly status?: ToolStatus;
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly contentText?: string;
}

function extractToolInfo(payload: unknown): ToolInfo {
  if (!isRecord(payload)) return {};
  const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
  const title = typeof payload.title === "string" ? payload.title : undefined;
  const status = normalizeToolStatus(payload.status);
  const rawInput = "rawInput" in payload ? payload.rawInput : undefined;
  const rawOutput = "rawOutput" in payload ? payload.rawOutput : undefined;
  const contentText = extractContentText(payload.content);
  return { toolCallId, title, status, rawInput, rawOutput, contentText };
}

function extractPlanEntries(payload: unknown): ReadonlyArray<ChatPlanEntry> {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) return [];
  const entries: Array<ChatPlanEntry> = [];
  for (const entry of payload.entries) {
    if (!isRecord(entry) || typeof entry.content !== "string") continue;
    entries.push({
      content: entry.content,
      status: typeof entry.status === "string" ? entry.status : "pending",
      priority: typeof entry.priority === "string" ? entry.priority : undefined,
    });
  }
  return entries;
}

function extractUsage(payload: unknown): ChatUsage | undefined {
  if (!isRecord(payload)) return undefined;
  const pick = (keys: ReadonlyArray<string>): number | undefined => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  const inputTokens = pick(["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = pick(["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const totalTokens = pick(["totalTokens", "total_tokens", "tokens"]);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

interface PermissionInfo {
  readonly requestId: string;
  readonly title: string;
  readonly toolKind?: string;
  readonly options: ReadonlyArray<ChatPermissionOption>;
}

function extractPermission(payload: unknown): PermissionInfo | undefined {
  if (!isRecord(payload)) return undefined;
  const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
  if (!requestId) return undefined;

  const toolCall = isRecord(payload.toolCall) ? payload.toolCall : undefined;
  const title = (toolCall && typeof toolCall.title === "string" ? toolCall.title : undefined)
    ?? (typeof payload.title === "string" ? payload.title : undefined)
    ?? "permission requested";
  const toolKind = toolCall && typeof toolCall.kind === "string" ? toolCall.kind : undefined;

  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const options: Array<ChatPermissionOption> = [];
  for (const option of rawOptions) {
    if (!isRecord(option) || typeof option.optionId !== "string") continue;
    const label = typeof option.name === "string" ? option.name : typeof option.label === "string" ? option.label : option.optionId;
    options.push({ optionId: option.optionId, label });
  }

  return { requestId, title, toolKind, options };
}

function extractStatusText(payload: unknown): string | undefined {
  if (typeof payload === "string") return payload;
  if (isRecord(payload)) {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (typeof payload.text === "string") return payload.text;
  }
  return undefined;
}

const CHAT_STATUS_VALUES: ReadonlyArray<ChatStatus> = ["idle", "connecting", "live", "closed", "error"];

function extractStatusValue(payload: unknown): ChatStatus | undefined {
  if (!isRecord(payload) || typeof payload.status !== "string") return undefined;
  return (CHAT_STATUS_VALUES as ReadonlyArray<string>).includes(payload.status) ? (payload.status as ChatStatus) : undefined;
}

export function extractAuthMethods(result: unknown): ReadonlyArray<string> | undefined {
  if (!isRecord(result) || !Array.isArray(result.authMethods)) return undefined;
  const methods = result.authMethods.filter((method): method is string => typeof method === "string");
  return methods.length > 0 ? methods : undefined;
}

// --- transcript mutation helpers --------------------------------------------

function appendOrMergeText(
  transcript: ReadonlyArray<ChatItem>,
  kind: "assistant" | "thought",
  text: string,
): ReadonlyArray<ChatItem> {
  const last = transcript[transcript.length - 1];
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text };
    return [...transcript.slice(0, -1), merged];
  }
  return [...transcript, { kind, id: `${kind}-${ulid()}`, text, ts: Date.now() }];
}

function applyToolEvent(transcript: ReadonlyArray<ChatItem>, payload: unknown): ReadonlyArray<ChatItem> {
  const info = extractToolInfo(payload);
  if (!info.toolCallId) return transcript;
  const index = transcript.findIndex((item) => item.kind === "tool" && item.toolCallId === info.toolCallId);
  if (index === -1) {
    const item: ChatToolItem = {
      kind: "tool",
      id: info.toolCallId,
      toolCallId: info.toolCallId,
      title: info.title ?? "tool call",
      status: info.status ?? "pending",
      rawInput: info.rawInput,
      rawOutput: info.rawOutput,
      contentText: info.contentText,
      ts: Date.now(),
    };
    return [...transcript, item];
  }
  const existing = transcript[index] as ChatToolItem;
  const updated: ChatToolItem = {
    ...existing,
    title: info.title ?? existing.title,
    status: info.status ?? existing.status,
    rawInput: info.rawInput ?? existing.rawInput,
    rawOutput: info.rawOutput ?? existing.rawOutput,
    contentText: info.contentText ?? existing.contentText,
  };
  const next = transcript.slice();
  next[index] = updated;
  return next;
}

function applyEvent(state: AgentChatState, event: ChatEvent): AgentChatState {
  switch (event.kind) {
    case "agent_message_chunk": {
      const text = extractChunkText(event.payload);
      return text === undefined ? state : { ...state, transcript: appendOrMergeText(state.transcript, "assistant", text) };
    }
    case "agent_thought_chunk": {
      const text = extractChunkText(event.payload);
      return text === undefined ? state : { ...state, transcript: appendOrMergeText(state.transcript, "thought", text) };
    }
    case "tool_call":
    case "tool_call_update": {
      const transcript = applyToolEvent(state.transcript, event.payload);
      return transcript === state.transcript ? state : { ...state, transcript };
    }
    case "plan": {
      const entries = extractPlanEntries(event.payload);
      if (entries.length === 0) return state;
      const item: ChatPlanItem = { kind: "plan", id: `plan-${ulid()}`, entries, ts: Date.now() };
      return { ...state, transcript: [...state.transcript, item] };
    }
    case "usage_update": {
      const usage = extractUsage(event.payload);
      return usage ? { ...state, usage } : state;
    }
    case "permission_request": {
      const permission = extractPermission(event.payload);
      if (!permission) return state;
      const item: ChatPermissionItem = { kind: "permission", id: permission.requestId, ts: Date.now(), ...permission };
      return { ...state, pendingPermission: { requestId: permission.requestId }, transcript: [...state.transcript, item] };
    }
    case "status": {
      const nextStatus = extractStatusValue(event.payload);
      const text = extractStatusText(event.payload);
      const withStatus = nextStatus ? { ...state, status: nextStatus } : state;
      if (!text) return withStatus;
      const item: ChatStatusItem = { kind: "status", id: `status-${ulid()}`, text, level: "info", ts: Date.now() };
      return { ...withStatus, transcript: [...withStatus.transcript, item] };
    }
    case "error": {
      const text = extractStatusText(event.payload) ?? "agent error";
      const item: ChatStatusItem = { kind: "status", id: `status-${ulid()}`, text, level: "error", ts: Date.now() };
      return { ...state, status: "error", error: text, transcript: [...state.transcript, item] };
    }
    default:
      // Unhandled ACP kinds (available_commands_update, ...) — quiet no-op.
      return state;
  }
}

// Pure reducer: (state, event) -> state. Bumps `unread` exactly once per
// newly-appended transcript item (a merged chunk does not re-bump it) so the
// InspectorTabs badge only counts genuinely new activity.
export function reduceChatEvent(state: AgentChatState, event: ChatEvent): AgentChatState {
  const next = applyEvent(state, event);
  if (next.transcript.length > state.transcript.length) {
    return { ...next, unread: next.unread + 1 };
  }
  return next;
}

// --- store + actions ---------------------------------------------------------

export const chatState$ = observable<Record<string, AgentChatState>>({});

/** Coarse chrome projection — status transitions only, no transcript.
 *  Streaming tokens notify chatState$ only; region chrome / activity marks
 *  subscribe here so they re-render on real status flips, not per token. */
export type AgentChatCoarse = {
  readonly status: ChatStatus;
  readonly pendingPermissionId?: string;
  readonly turnBusy: boolean;
  readonly hasBusyTools: boolean;
};

export const chatCoarse$ = observable<Record<string, AgentChatCoarse>>({});

const initialCoarse = (): AgentChatCoarse => ({
  status: "idle",
  turnBusy: false,
  hasBusyTools: false,
});

const hasBusyToolsFromTranscript = (transcript: ReadonlyArray<ChatItem>): boolean =>
  transcript.some(
    (item) => item.kind === "tool" && (item.status === "pending" || item.status === "in_progress"),
  );

/** Events that can flip tool busy flags — skip transcript scan on pure text chunks. */
const toolsMayChangeKind = (kind: string): boolean =>
  kind === "tool_call" || kind === "tool_call_update";

const syncChatCoarse = (
  agentKey: string,
  state: AgentChatState,
  opts?: { readonly rescanTools?: boolean },
): void => {
  const prev = chatCoarse$[agentKey].peek();
  const hasBusyTools =
    opts?.rescanTools === false && prev !== undefined
      ? prev.hasBusyTools
      : hasBusyToolsFromTranscript(state.transcript);
  const next: AgentChatCoarse = {
    status: state.status,
    pendingPermissionId: state.pendingPermission?.requestId,
    turnBusy: state.turnBusy,
    hasBusyTools,
  };
  if (
    prev &&
    prev.status === next.status &&
    prev.pendingPermissionId === next.pendingPermissionId &&
    prev.turnBusy === next.turnBusy &&
    prev.hasBusyTools === next.hasBusyTools
  ) {
    return;
  }
  chatCoarse$[agentKey].set(next);
};

/** Single write path for full-slot replacement — keeps chatCoarse$ in lockstep. */
export function setAgentChatState(agentKey: string, next: AgentChatState): void {
  chatState$[agentKey].set(next);
  syncChatCoarse(agentKey, next);
}

function ensureAgent(agentKey: string): void {
  if (chatState$[agentKey].peek() === undefined) {
    chatState$[agentKey].set(initialAgentChatState());
    chatCoarse$[agentKey].set(initialCoarse());
  }
}

export function getAgentChatState(agentKey: string): AgentChatState {
  return chatState$[agentKey].peek() ?? initialAgentChatState();
}

// A plain-value .set() (peek current, compute next, set next) rather than
// the functional-updater overload — Legend State's ObservableArray type
// (which reserves Array.prototype.at()) doesn't cleanly resolve the updater
// overload against ReadonlyArray<ChatItem>'s union element type.
function updateTranscript(agentKey: string, updater: (prev: ReadonlyArray<ChatItem>) => ReadonlyArray<ChatItem>): void {
  const current = chatState$[agentKey].transcript.peek() ?? [];
  chatState$[agentKey].transcript.set(updater(current));
}

function pushStatus(agentKey: string, text: string, level: "info" | "error"): void {
  ensureAgent(agentKey);
  const item: ChatStatusItem = { kind: "status", id: `status-${ulid()}`, text, level, ts: Date.now() };
  updateTranscript(agentKey, (prev) => [...prev, item]);
}

export async function openChat(
  agentKey: string,
  resumeSessionId?: string,
  bindPin?: { readonly canvasName: string; readonly nodeId: string },
): Promise<void> {
  ensureAgent(agentKey);
  chatState$[agentKey].assign({ status: "connecting", error: undefined, authMethods: undefined });
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
  const api = getChatApi();
  if (!api || typeof api.chatOpen !== "function") {
    chatState$[agentKey].assign({ status: "error", error: "chat unavailable" });
    syncChatCoarse(agentKey, getAgentChatState(agentKey));
    return;
  }
  try {
    const result: ChatOpenResult = await api.chatOpen(agentKey, resumeSessionId, bindPin);
    if (result.ok) {
      chatState$[agentKey].assign({
        status: "live",
        sessionId: result.sessionId,
        models: result.models ?? [],
        selectedModelId: result.models?.[0]?.modelId,
        error: undefined,
        authMethods: undefined,
      });
    } else {
      chatState$[agentKey].assign({
        status: "error",
        error: result.error ?? "failed to open chat",
        authMethods: extractAuthMethods(result),
      });
    }
  } catch (error) {
    chatState$[agentKey].assign({ status: "error", error: error instanceof Error ? error.message : String(error) });
  }
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
}

export async function sendPrompt(
  agentKey: string,
  text: string,
  contextBlocks?: ReadonlyArray<{ readonly label: string; readonly text: string }>,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  ensureAgent(agentKey);
  const userItem: ChatUserItem = { kind: "user", id: `user-${ulid()}`, text: trimmed, ts: Date.now() };
  updateTranscript(agentKey, (prev) => [...prev, userItem]);
  const api = getChatApi();
  if (!api || typeof api.chatPrompt !== "function") {
    pushStatus(agentKey, "chat unavailable", "error");
    return;
  }
  chatState$[agentKey].turnBusy.set(true);
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
  try {
    const result = await api.chatPrompt(agentKey, trimmed, contextBlocks?.map((block) => block.text));
    if (!result.ok) pushStatus(agentKey, result.error ?? "turn failed", "error");
  } catch (error) {
    pushStatus(agentKey, error instanceof Error ? error.message : String(error), "error");
  } finally {
    chatState$[agentKey].turnBusy.set(false);
    syncChatCoarse(agentKey, getAgentChatState(agentKey));
  }
}

export async function answerPermission(agentKey: string, requestId: string, optionId: string): Promise<void> {
  ensureAgent(agentKey);
  updateTranscript(agentKey, (prev) =>
    prev.map((item) => (item.kind === "permission" && item.requestId === requestId ? { ...item, answeredOptionId: optionId } : item)),
  );
  const pending = chatState$[agentKey].pendingPermission.peek();
  if (pending?.requestId === requestId) chatState$[agentKey].pendingPermission.set(undefined);
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
  const api = getChatApi();
  if (!api || typeof api.chatPermission !== "function") {
    pushStatus(agentKey, "permission response unavailable", "error");
    return;
  }
  try {
    const result = await api.chatPermission(agentKey, requestId, optionId);
    if (!result.ok) pushStatus(agentKey, "permission response failed", "error");
  } catch (error) {
    pushStatus(agentKey, error instanceof Error ? error.message : String(error), "error");
  }
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
}

export async function setModel(agentKey: string, modelId: string): Promise<void> {
  ensureAgent(agentKey);
  const api = getChatApi();
  if (!api || typeof api.chatSetModel !== "function") {
    pushStatus(agentKey, "model switch unavailable", "error");
    return;
  }
  try {
    const result = await api.chatSetModel(agentKey, modelId);
    if (result.ok) {
      chatState$[agentKey].selectedModelId.set(modelId);
    } else {
      pushStatus(agentKey, result.error ?? "model switch failed", "error");
    }
  } catch (error) {
    pushStatus(agentKey, error instanceof Error ? error.message : String(error), "error");
  }
}

export async function closeChat(agentKey: string): Promise<void> {
  ensureAgent(agentKey);
  chatState$[agentKey].assign({ status: "closed", pendingPermission: undefined });
  syncChatCoarse(agentKey, getAgentChatState(agentKey));
  const api = getChatApi();
  if (!api || typeof api.chatClose !== "function") return;
  try {
    await api.chatClose(agentKey);
  } catch {
    // Closing is best-effort — local state already reflects "closed".
  }
}

export function markRead(agentKey: string): void {
  ensureAgent(agentKey);
  chatState$[agentKey].unread.set(0);
}

// Singleton fan-out: window.vellum.onChatEvent -> the right agent's slot in
// chatState$. Safe to call from every ChatView mount; only the first call
// actually subscribes. Absent onChatEvent (IPC not landed yet) degrades to a
// no-op unsubscribe rather than throwing.
let activeUnsubscribe: (() => void) | undefined;

export function subscribeChatEvents(): () => void {
  if (activeUnsubscribe) return activeUnsubscribe;
  const api = getChatApi();
  if (!api || typeof api.onChatEvent !== "function") {
    return () => undefined;
  }
  const unsubscribe = api.onChatEvent((event) => {
    if (!event || typeof event.agentKey !== "string") return;
    ensureAgent(event.agentKey);
    const next = reduceChatEvent(getAgentChatState(event.agentKey), event);
    chatState$[event.agentKey].set(next);
    // Token chunks never flip tool busy — skip O(transcript) scan.
    syncChatCoarse(event.agentKey, next, {
      rescanTools: toolsMayChangeKind(event.kind) || chatCoarse$[event.agentKey].peek() === undefined,
    });
  });
  activeUnsubscribe = () => {
    unsubscribe();
    activeUnsubscribe = undefined;
  };
  return activeUnsubscribe;
}
