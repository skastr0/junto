import { afterEach, describe, expect, it, vi } from "vitest";
import { OverseerLiveMedia, type LiveMediaState } from "../src/renderer/lib/overseer-live-media";
import type { LiveSnapshot, LiveStartResult } from "../src/shared/overseer-live";

const snapshot: LiveSnapshot = {
  sessionId: "session-1", canvasName: "Factory", nodeId: "overseer", connectionEpoch: 1,
  connection: "connecting", authority: "active", controller: "idle", elapsedSeconds: 0,
  voiceCostUsd: 0, limitSeconds: 600, transcript: [], requests: [], actions: [],
};
const started: LiveStartResult = { sessionId: "session-1", connectionEpoch: 1, answerSdp: "answer", snapshot };
const input = { canvasName: "Factory", nodeId: "overseer", attention: { canvasName: "Factory", selectedNodeIds: ["task-1"] } };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture() {
  const track = { enabled: true, stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close: vi.fn(),
  };
  const peer = {
    localDescription: { sdp: "offer" }, connectionState: "new",
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null as ((event: { streams: MediaStream[] }) => void) | null,
    createDataChannel: vi.fn(() => channel), addTrack: vi.fn(),
    createOffer: vi.fn(async () => {
      expect(channel.onmessage).toBeTypeOf("function");
      expect(track.enabled).toBe(false);
      return { type: "offer", sdp: "offer" };
    }),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined), close: vi.fn(),
  };
  const audio = {
    autoplay: false, srcObject: null as MediaStream | null,
    onplaying: null as (() => void) | null, onpause: null as (() => void) | null,
    play: vi.fn(async () => undefined), pause: vi.fn(), remove: vi.fn(),
  };
  const api = {
    liveStart: vi.fn(async () => started),
    liveReady: vi.fn(async (): Promise<void> => undefined),
    liveProviderEvent: vi.fn(async (_sessionId: string, _epoch: number, _event: unknown) => undefined),
    liveEnd: vi.fn(async () => ({ ...snapshot, connection: "closed" as const })),
  };
  const states: LiveMediaState[] = [];
  const getMicrophone = vi.fn(async () => stream);
  const control = new OverseerLiveMedia({
    api, getMicrophone,
    createPeer: () => peer as unknown as RTCPeerConnection,
    createAudio: () => audio as unknown as HTMLAudioElement,
    onState: (state) => states.push(state), onStarted: vi.fn(), startupTimeoutMs: 1000,
  });
  const emit = (event: unknown) => channel.onmessage?.({ data: JSON.stringify(event) });
  return { track, stream, channel, peer, audio, api, states, control, emit, getMicrophone };
}

afterEach(() => vi.useRealTimers());

describe("Overseer live media ownership", () => {
  it("gates microphone on both sideband completion and observed session.started, with main ready acknowledgment last", async () => {
    const f = fixture();
    const start = deferred<LiveStartResult>();
    const ready = deferred<void>();
    f.api.liveStart.mockReturnValue(start.promise);
    f.api.liveReady.mockReturnValue(ready.promise);
    const opening = f.control.start(input);
    await vi.waitFor(() => expect(f.api.liveStart).toHaveBeenCalled());
    f.emit({ type: "session.started", event_id: "start" });
    f.emit({ type: "transcript.done", event_id: "early", text: "Move this" });
    expect(f.track.enabled).toBe(false);
    expect(f.api.liveReady).not.toHaveBeenCalled();
    start.resolve(started);
    await vi.waitFor(() => expect(f.api.liveReady).toHaveBeenCalledOnce());
    expect(f.api.liveProviderEvent).toHaveBeenNthCalledWith(1, "session-1", 1, { type: "session.started", event_id: "start" });
    expect(f.api.liveProviderEvent).toHaveBeenNthCalledWith(2, "session-1", 1, { type: "transcript.done", event_id: "early", text: "Move this" });
    expect(f.track.enabled).toBe(false);
    ready.resolve();
    await opening;
    expect(f.track.enabled).toBe(true);
    f.emit({ type: "session.started", event_id: "start" });
    await vi.waitFor(() => expect(f.api.liveProviderEvent).toHaveBeenCalledTimes(3));
    expect(f.api.liveReady).toHaveBeenCalledOnce();
    await f.control.end();
  });

  it("waits for session.started even when main is ready, and mute does not end requests or transport", async () => {
    const f = fixture();
    await f.control.start(input);
    expect(f.track.enabled).toBe(false);
    expect(f.api.liveReady).not.toHaveBeenCalled();
    f.emit({ type: "session.started" });
    await vi.waitFor(() => expect(f.track.enabled).toBe(true));
    f.control.setMuted(true);
    expect(f.track.enabled).toBe(false);
    expect(f.states.at(-1)?.microphone).toBe("muted");
    expect(f.peer.close).not.toHaveBeenCalled();
    expect(f.api.liveEnd).not.toHaveBeenCalled();
    f.control.setMuted(false);
    expect(f.track.enabled).toBe(true);
    await f.control.end();
  });

  it("stops local and remote media, closes peer/data channel, and removes audio on end", async () => {
    const f = fixture();
    await f.control.start(input);
    const remoteTrack = { stop: vi.fn() };
    f.audio.srcObject = { getTracks: () => [remoteTrack] } as unknown as MediaStream;
    await f.control.end();
    await f.control.end();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(remoteTrack.stop).toHaveBeenCalledOnce();
    expect(f.channel.close).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.audio.pause).toHaveBeenCalledOnce();
    expect(f.audio.srcObject).toBe(null);
    expect(f.audio.remove).toHaveBeenCalledOnce();
    expect(f.channel.onmessage).toBe(null);
    expect(f.api.liveEnd).toHaveBeenCalledOnce();
  });

  it("closes a late provider session when the operator ends during negotiation", async () => {
    const f = fixture();
    const start = deferred<LiveStartResult>();
    f.api.liveStart.mockReturnValue(start.promise);
    const opening = f.control.start(input);
    await vi.waitFor(() => expect(f.api.liveStart).toHaveBeenCalled());
    await f.control.end();
    start.resolve(started);
    await opening;
    expect(f.api.liveEnd).toHaveBeenCalledWith("session-1");
    expect(f.api.liveReady).not.toHaveBeenCalled();
    expect(f.peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("stops microphone permission arriving after unmount without opening a provider session", async () => {
    const f = fixture();
    const microphone = deferred<MediaStream>();
    f.getMicrophone.mockReturnValue(microphone.promise);
    const opening = f.control.start(input);
    await f.control.end();
    microphone.resolve(f.stream);
    await opening;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.api.liveStart).not.toHaveBeenCalled();
  });

  it("releases media on main revocation without sending a second end command", async () => {
    const f = fixture();
    await f.control.start(input);
    f.control.release();
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.api.liveEnd).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.microphone).toBe("off");
  });

  it("cleans up on readiness refusal and never enables the microphone", async () => {
    const f = fixture();
    f.api.liveReady.mockRejectedValue(new Error("Overseer revoked"));
    await f.control.start(input);
    f.emit({ type: "session.started" });
    await vi.waitFor(() => expect(f.states.at(-1)?.connection).toBe("failed"));
    expect(f.track.enabled).toBe(false);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.states.at(-1)?.error).toBe("Overseer revoked");
  });

  it("keeps playback failure independent from microphone readiness and allows recovery", async () => {
    const f = fixture();
    f.audio.play.mockRejectedValueOnce(new Error("User gesture needed"));
    await f.control.start(input);
    f.emit({ type: "session.started" });
    await vi.waitFor(() => expect(f.track.enabled).toBe(true));
    f.peer.ontrack?.({ streams: [f.stream] });
    await vi.waitFor(() => expect(f.states.at(-1)?.playback).toBe("blocked"));
    expect(f.track.enabled).toBe(true);
    await f.control.resumePlayback();
    f.audio.onplaying?.();
    expect(f.states.at(-1)?.playback).toBe("playing");
    await f.control.end();
  });

  it("times out missing startup and releases every captured resource", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.control.start(input);
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.states.at(-1)?.connection).toBe("failed");
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.peer.close).toHaveBeenCalledOnce();
    expect(f.api.liveEnd).toHaveBeenCalledOnce();
  });
});
