import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ChatService } from "../src/main/junto/chat/service";
import { ChatChromeSnapshot, type ChatChromeChanged } from "../src/shared/chat-chrome";
import type { AcpChildLike, JsonRpcId, SpawnFn } from "../src/main/junto/chat/acp-client";
import { spawnedLocalAcp } from "./helpers/acp-child";

class Child extends EventEmitter implements AcpChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: string[] = [];
  readonly stdin = { write: (chunk: string) => { this.written.push(chunk); return true; } };
  kill = () => { this.emit("exit", 0); this.emit("close", 0); return true; };
}
const settle = async (child: Child, count: number) => {
  for (let i = 0; i < 100 && child.written.length < count; i++) await Promise.resolve();
  expect(child.written.length).toBeGreaterThanOrEqual(count);
};
const frame = (child: Child, value: unknown) => child.stdout.emit("data", JSON.stringify(value) + "\n");
const respond = (child: Child, result: unknown) => {
  const id = (JSON.parse(child.written.at(-1)!) as { id: JsonRpcId }).id;
  frame(child, { jsonrpc: "2.0", id, result });
};
const open = async (service: ChatService, child: Child) => {
  const pending = service.chatOpen("local:default");
  await settle(child, 1);
  respond(child, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  await settle(child, 2);
  respond(child, { sessionId: "current-session" });
  expect((await pending).ok).toBe(true);
};
const permission = (child: Child, id: number) => frame(child, {
  jsonrpc: "2.0", id, method: "session/request_permission",
  params: { sessionId: "current-session", options: [{ optionId: "allow" }] },
});
const fixture = () => {
  const child = new Child();
  const spawn: SpawnFn = () => spawnedLocalAcp(child);
  return { child, service: new ChatService(spawn, () => true) };
};

describe("ACP chrome hydration", () => {
  it("hydrates an already-pending permission without a chat view or transcript", async () => {
    const { child, service } = fixture();
    try {
      expect(service.chromeSnapshot()).toEqual({ revision: 0, states: [] });
      await open(service, child);
      permission(child, 42);
      const snapshot = service.chromeSnapshot();
      expect(snapshot).toEqual({ revision: 2, states: [
        { agentKey: "local:default", sessionLive: true, permissionPending: true },
      ] });
      expect(Schema.decodeUnknownSync(ChatChromeSnapshot)(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    } finally { await service.closeAll(); }
  });

  it("only announces changed bits, including the last answer and closure", async () => {
    const { child, service } = fixture();
    const changes: ChatChromeChanged[] = [];
    service.subscribeChromeChanges(() => { throw new Error("stale observer"); });
    const unsubscribe = service.subscribeChromeChanges((event) => changes.push(event));
    try {
      await open(service, child);
      permission(child, 1);
      const initial = service.chromeSnapshot();
      permission(child, 2);
      frame(child, { jsonrpc: "2.0", method: "session/update", params: {
        update: { sessionUpdate: "agent_message_chunk", content: { text: "streaming" } },
      } });
      expect(changes).toHaveLength(2);
      expect(await service.chatPermission("local:default", "1", "allow")).toEqual({ ok: true });
      expect(changes).toHaveLength(2);
      expect(await service.chatPermission("local:default", "2", "allow")).toEqual({ ok: true });
      expect(changes.at(-1)).toEqual({ revision: initial.revision + 1, state: {
        agentKey: "local:default", sessionLive: true, permissionPending: false,
      } });
      await service.chatClose("local:default");
      expect(changes.at(-1)).toEqual({ revision: initial.revision + 2, state: {
        agentKey: "local:default", sessionLive: false, permissionPending: false,
      } });
      expect(service.chromeSnapshot()).toEqual({ revision: initial.revision + 2, states: [] });
      expect(changes.filter((event) => event.revision > initial.revision)).toHaveLength(2);
      expect(changes.map((event) => event.revision)).toEqual([1, 2, 3, 4]);
      unsubscribe();
      permission(child, 3); // An exited generation cannot restore stale attention.
      expect(changes).toHaveLength(4);
    } finally { await service.closeAll(); }
  });

  it("clears a pending permission immediately when its session closes", async () => {
    const { child, service } = fixture();
    try {
      await open(service, child);
      permission(child, 9);
      const changes: ChatChromeChanged[] = [];
      service.subscribeChromeChanges((event) => changes.push(event));
      const closing = service.chatClose("local:default");
      expect(service.hasPendingPermission("local:default")).toBe(false);
      expect(service.chromeSnapshot().states).toEqual([]);
      expect(changes).toHaveLength(1);
      expect(changes[0]?.state).toEqual({ agentKey: "local:default", sessionLive: false, permissionPending: false });
      await closing;
      expect(changes).toHaveLength(1);
    } finally { await service.closeAll(); }
  });

  it("late observers get the current state and subsequent revisions", async () => {
    const { child, service } = fixture();
    try {
      await open(service, child);
      permission(child, 7);
      const buffered: ChatChromeChanged[] = [];
      const unsubscribe = service.subscribeChromeChanges((event) => buffered.push(event));
      const snapshot = service.chromeSnapshot();
      await service.chatPermission("local:default", "7", "allow");
      expect(snapshot.states[0]?.permissionPending).toBe(true);
      expect(buffered[0]?.revision).toBeGreaterThan(snapshot.revision);
      expect(buffered[0]?.state.permissionPending).toBe(false);
      unsubscribe();
    } finally { await service.closeAll(); }
  });
});
