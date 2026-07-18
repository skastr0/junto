import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/main/vellum/chat/service";
import type { AcpChildLike, SpawnFn } from "../src/main/vellum/chat/acp-client";

const makeChild = (): AcpChildLike => {
  const child = new EventEmitter() as AcpChildLike & EventEmitter;
  (child as { stdin: { write: (chunk: string) => boolean } }).stdin = {
    write: () => true,
  };
  (child as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as { kill: () => boolean }).kill = () => true;
  return child;
};

const spawnFn: SpawnFn = () => makeChild();

afterEach(() => {
  delete process.env.VELLUM_ACP_MAX_REMOTE_SESSIONS_PER_HOST;
  delete process.env.VELLUM_ACP_IDLE_MS;
});

describe("ChatService remote session policy", () => {
  it("evicts idle remote sessions but never busy ones", async () => {
    process.env.VELLUM_ACP_IDLE_MS = "1000";
    const service = new ChatService(spawnFn);
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
    expect(anyService.sessions.has("remote-a:a")).toBe(false);
    expect(anyService.sessions.has("remote-a:b")).toBe(true);
    expect(close).toHaveBeenCalled();
    service.closeAll();
  });

  it("enforces per-host remote ceiling by closing LRU idle peer", async () => {
    process.env.VELLUM_ACP_MAX_REMOTE_SESSIONS_PER_HOST = "1";
    process.env.VELLUM_ACP_IDLE_MS = "0"; // disable idle sweep noise
    const service = new ChatService(spawnFn);
    service.stopIdleSweep();

    const anyService = service as unknown as {
      sessions: Map<string, unknown>;
      generations: Map<string, number>;
      enforceRemoteCeiling: (host: string, openingKey: string) => string | undefined;
      closeCurrent: (key: string) => void;
    };

    const close = vi.fn();
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
    expect(anyService.sessions.has("remote-a:old")).toBe(false);
    expect(close).toHaveBeenCalled();
    service.closeAll();
  });
});
