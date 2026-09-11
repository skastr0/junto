import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/main/vellum-command/chat/service";
import type { SpawnFn } from "../src/main/vellum-command/chat/acp-client";
import type { ChatEvent } from "../src/shared/ipc";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import { setHostsSnapshot } from "../src/main/vellum-command/hosts/snapshot";
import {
  spawnedLocalAcp,
  type TestLocalAcpChild,
} from "./helpers/acp-child";

const makeChild = (): TestLocalAcpChild => {
  const child = new EventEmitter() as TestLocalAcpChild & EventEmitter;
  (child as { stdin: { write: (chunk: string) => boolean } }).stdin = {
    write: () => true,
  };
  (child as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as { stderr: EventEmitter }).stderr = new EventEmitter();
  child.kill = () => true;
  return child;
};

const spawnFn: SpawnFn = () => spawnedLocalAcp(makeChild());

afterEach(() => {
  delete process.env.VELLUM_COMMAND_ACP_MAX_REMOTE_SESSIONS_PER_HOST;
  delete process.env.VELLUM_COMMAND_ACP_IDLE_MS;
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
});

describe("ChatService remote session policy", () => {
  it("evicts idle remote sessions but never busy ones", async () => { // async: closeCurrent settles teardown
    process.env.VELLUM_COMMAND_ACP_IDLE_MS = "1000";
    const service = new ChatService(spawnFn, (host) => host === "local");
    service.stopIdleSweep();

    // Inject two live remote sessions by reaching into private state via open
    // is heavy (handshake). Exercise eviction helpers through public seams by
    // simulating post-open sessions via a narrow test double path:
    const anyService = service as unknown as {
      sessions: Map<
        string,
        {
          host: string;
          sessionId: string;
          promptInFlight: boolean;
          pendingPermissions: Map<string, unknown>;
          lastActivityAt: number;
          client: { closed: boolean; close: () => void };
          generation: number;
        }
      >;
      generations: Map<string, number>;
      evictIdleSessions: (now?: number) => ReadonlyArray<string>;
    };

    const close = vi.fn();
    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));
    anyService.sessions.set("remote-a:a", {
      host: "remote-a",
      sessionId: "s-a",
      promptInFlight: false,
      pendingPermissions: new Map(),
      lastActivityAt: Date.now() - 60_000,
      client: { closed: false, close },
      generation: 1,
    });
    anyService.generations.set("remote-a:a", 1);

    anyService.sessions.set("remote-a:b", {
      host: "remote-a",
      sessionId: "s-b",
      promptInFlight: true,
      pendingPermissions: new Map(),
      lastActivityAt: Date.now() - 60_000,
      client: { closed: false, close },
      generation: 1,
    });
    anyService.generations.set("remote-a:b", 1);

    const closed = anyService.evictIdleSessions(Date.now());
    expect(closed).toEqual(["remote-a:a"]);
    // closeCurrent keeps the map entry until teardown settles (async).
    await vi.waitFor(() => expect(anyService.sessions.has("remote-a:a")).toBe(false));
    expect(anyService.sessions.has("remote-a:b")).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(events).toContainEqual({
      agentKey: "remote-a:a",
      kind: "status",
      payload: { status: "closed", text: "remote chat closed after 1000ms idle" },
    });
    await service.closeAll();
  });

  it("enforces per-host remote ceiling by closing LRU idle peer", async () => {
    process.env.VELLUM_COMMAND_ACP_MAX_REMOTE_SESSIONS_PER_HOST = "1";
    process.env.VELLUM_COMMAND_ACP_IDLE_MS = "0"; // disable idle sweep noise
    const service = new ChatService(spawnFn, (host) => host === "local");
    service.stopIdleSweep();

    const anyService = service as unknown as {
      sessions: Map<string, unknown>;
      generations: Map<string, number>;
      enforceRemoteCeiling: (host: string, openingKey: string) => string | undefined;
      closeCurrent: (key: string) => void;
    };

    const close = vi.fn();
    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));
    anyService.sessions.set("remote-a:old", {
      host: "remote-a",
      sessionId: "s-old",
      promptInFlight: false,
      pendingPermissions: new Map(),
      lastActivityAt: Date.now() - 10_000,
      client: { closed: false, close },
      generation: 1,
    });
    anyService.generations.set("remote-a:old", 1);

    const err = (
      service as unknown as {
        enforceRemoteCeiling: (host: string, key: string) => string | undefined;
      }
    ).enforceRemoteCeiling("remote-a", "remote-a:new");
    expect(err).toBeUndefined();
    await vi.waitFor(() => expect(anyService.sessions.has("remote-a:old")).toBe(false));
    expect(close).toHaveBeenCalled();
    expect(events).toContainEqual({
      agentKey: "remote-a:old",
      kind: "status",
      payload: {
        status: "closed",
        text: "remote chat closed to enforce the remote-a session ceiling (1)",
      },
    });
    await service.closeAll();
  });

  it("counts an in-flight remote handshake before admitting another child", async () => {
    process.env.VELLUM_COMMAND_ACP_MAX_REMOTE_SESSIONS_PER_HOST = "1";
    process.env.VELLUM_COMMAND_ACP_IDLE_MS = "0";
    const children: TestLocalAcpChild[] = [];
    const service = new ChatService(() => {
      const child = makeChild();
      children.push(child);
      return spawnedLocalAcp(child);
    }, (host) => host === "local");
    service.stopIdleSweep();

    // The first child deliberately never answers initialize, keeping its
    // session in the registered handshaking state.
    void service.chatOpen("studio:first");
    expect(children).toHaveLength(1);

    await expect(service.chatOpen("studio:second")).resolves.toEqual({
      ok: false,
      error: "remote ACP session ceiling reached for host studio (1 live; all busy) — close a chat or wait for a turn to finish",
    });
    expect(children).toHaveLength(1);
    service.closeAll();
  });

  it("closes live ACP sessions when their canonical remote route changes", async () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio-product",
        hermesId: "studio",
        label: "Studio",
        kind: "remote",
        sshEndpoint: "studio-old",
        capabilities: ["hermes"],
      },
    ]);
    const service = new ChatService(spawnFn, (host) => host === "local");
    service.stopIdleSweep();
    const anyService = service as unknown as {
      sessions: Map<string, unknown>;
      generations: Map<string, number>;
    };
    const close = vi.fn();
    const events: ChatEvent[] = [];
    service.setEventSink((event) => events.push(event));
    anyService.sessions.set("studio:agent", {
      host: "studio",
      sessionId: "session",
      promptInFlight: false,
      pendingPermissions: new Map(),
      lastActivityAt: Date.now(),
      client: { closed: false, close },
      generation: 1,
    });
    anyService.generations.set("studio:agent", 1);

    // Presentation-only edits preserve the exact transport route.
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio-product",
        hermesId: "studio",
        label: "Renamed Studio",
        kind: "remote",
        sshEndpoint: "studio-old",
        capabilities: ["hermes"],
      },
    ]);
    expect(close).not.toHaveBeenCalled();

    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "studio-product",
        hermesId: "studio",
        label: "Renamed Studio",
        kind: "remote",
        sshEndpoint: "studio-new",
        capabilities: ["hermes"],
      },
    ]);

    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(anyService.sessions.has("studio:agent")).toBe(false));
    expect(events).toContainEqual({
      agentKey: "studio:agent",
      kind: "status",
      payload: {
        status: "closed",
        text: "remote chat closed because host studio routing changed",
      },
    });
    await service.closeAll();
  });
});
