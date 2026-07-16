import { describe, expect, it } from "vitest";
import {
  herdrDeleteAction,
  initialHerdrConnection,
  reduceHerdrConnection,
  shouldAutoReconnect,
} from "../src/shared/herdr";
import { IPC_CHANNELS } from "../src/shared/ipc";

describe("herdr delete decision matrix", () => {
  it("defaults to detach", () => {
    expect(herdrDeleteAction({ paneId: "w1:p1" })).toBe("detach");
    expect(herdrDeleteAction({ onDelete: "detach", paneId: "w1:p1" })).toBe("detach");
  });

  it("kill-pane policy kills when paneId present", () => {
    expect(herdrDeleteAction({ onDelete: "kill-pane", paneId: "w1:p1" })).toBe("kill-pane");
  });

  it("kill-pane policy without paneId falls back to detach", () => {
    expect(herdrDeleteAction({ onDelete: "kill-pane" })).toBe("detach");
  });

  it("explicit kill requires paneId", () => {
    expect(herdrDeleteAction({ explicitKill: true, paneId: "w1:p1" })).toBe("kill-pane");
    expect(herdrDeleteAction({ explicitKill: true })).toBe("noop");
  });
});

describe("herdr connection state machine", () => {
  it("stream drop degrades and allows bounded reconnect", () => {
    let m = initialHerdrConnection(3);
    m = reduceHerdrConnection(m, { type: "stream_drop" });
    expect(m.state).toBe("degraded");
    expect(shouldAutoReconnect(m)).toBe(true);
    m = reduceHerdrConnection(m, { type: "reconnect_start" });
    m = reduceHerdrConnection(m, { type: "reconnect_start" });
    m = reduceHerdrConnection(m, { type: "reconnect_start" });
    m = reduceHerdrConnection(m, { type: "reconnect_start" });
    expect(m.state).toBe("failed");
    expect(shouldAutoReconnect(m)).toBe(false);
  });

  it("host unreachable is degraded not lost", () => {
    let m = initialHerdrConnection();
    m = reduceHerdrConnection(m, { type: "host_unreachable" });
    expect(m.state).toBe("degraded");
  });

  it("pane missing becomes lost; reconnected clears", () => {
    let m = initialHerdrConnection();
    m = reduceHerdrConnection(m, { type: "pane_missing" });
    expect(m.state).toBe("lost");
    m = reduceHerdrConnection(m, { type: "reconnected" });
    expect(m.state).toBe("connected");
    expect(m.reconnectAttempts).toBe(0);
  });
});

describe("herdr ipc channels", () => {
  it("declares stream event channel and control channels", () => {
    expect(IPC_CHANNELS.herdrStreamEvent).toBe("vellum:herdr-stream-event");
    expect(IPC_CHANNELS.herdrStreamOpen).toBe("vellum:herdr-stream-open");
    expect(IPC_CHANNELS.herdrStreamClipboardImage).toBe("vellum:herdr-stream-clipboard-image");
    expect(IPC_CHANNELS.herdrHosts).toBe("vellum:herdr-hosts");
    expect(IPC_CHANNELS.herdrGetMeta).toBe("vellum:herdr-get-meta");
  });
});
