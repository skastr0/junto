import type { LiveStartInput, LiveStartResult, OverseerLiveApi } from "@shared/overseer-live";

export interface LiveMediaState {
  readonly connection: "idle" | "connecting" | "ready" | "closed" | "failed";
  readonly microphone: "off" | "waiting" | "live" | "muted";
  readonly playback: "off" | "ready" | "playing" | "blocked";
  readonly error?: string;
}

export interface LiveMediaDependencies {
  readonly api: Pick<OverseerLiveApi, "liveStart" | "liveReady" | "liveProviderEvent" | "liveEnd">;
  readonly getMicrophone: () => Promise<MediaStream>;
  readonly createPeer: () => RTCPeerConnection;
  readonly createAudio: () => HTMLAudioElement;
  readonly onState: (state: LiveMediaState) => void;
  readonly onStarted: (result: LiveStartResult) => void;
  readonly startupTimeoutMs?: number;
}

/** Renderer owns media only. Main owns provider authentication and delegated work. */
export class OverseerLiveMedia {
  private peer: RTCPeerConnection | undefined;
  private stream: MediaStream | undefined;
  private audio: HTMLAudioElement | undefined;
  private channel: RTCDataChannel | undefined;
  private result: LiveStartResult | undefined;
  private closed = false;
  private muted = false;
  private providerStarted = false;
  private admitted = false;
  private readyPending = false;
  private providerQueue: unknown[] = [];
  private eventTail: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private state: LiveMediaState = { connection: "idle", microphone: "off", playback: "off" };

  constructor(private readonly deps: LiveMediaDependencies) {}

  private update(patch: Partial<LiveMediaState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  async start(input: Omit<LiveStartInput, "offerSdp">): Promise<void> {
    if (this.closed || this.state.connection !== "idle") return;
    this.update({ connection: "connecting", microphone: "waiting" });
    try {
      const stream = await this.deps.getMicrophone();
      for (const track of stream.getTracks()) track.enabled = false;
      if (this.closed) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      for (const track of stream.getAudioTracks()) {
        track.onended = () => this.fail(new Error("The microphone is no longer available. Start the call again after reconnecting it."));
      }
      const peer = this.deps.createPeer();
      this.peer = peer;
      const audio = this.deps.createAudio();
      this.audio = audio;
      audio.autoplay = true;
      audio.onplaying = () => { if (!this.closed) this.update({ playback: "playing" }); };
      audio.onpause = () => { if (!this.closed) this.update({ playback: "ready" }); };
      peer.ontrack = (event) => {
        if (this.closed) return;
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        this.update({ playback: "ready" });
        void this.resumePlayback();
      };
      peer.onconnectionstatechange = () => {
        if (!this.closed && ["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.fail(new Error("The voice connection ended. Existing requests remain available below."));
        }
      };
      // Capture events before creating or negotiating the offer. Sideband does
      // not replay startup history; main deduplicates these observations.
      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      channel.onmessage = (event) => {
        if (this.closed || typeof event.data !== "string") return;
        try {
          const value: unknown = JSON.parse(event.data);
          if (this.result) this.forward(value);
          else this.providerQueue.push(value);
          if (typeof value === "object" && value !== null && "type" in value && value.type === "session.started") {
            this.providerStarted = true;
            void this.admitMicrophone();
          }
        } catch {
          this.fail(new Error("The voice provider sent an unreadable event."));
        }
      };
      channel.onclose = () => {
        if (!this.closed) this.fail(new Error("The voice event connection closed."));
      };
      channel.onerror = () => this.fail(new Error("The voice event connection failed."));
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      this.timer = setTimeout(() => this.fail(new Error("Voice setup timed out. Start the call again.")), this.deps.startupTimeoutMs ?? 30_000);
      const offer = await peer.createOffer();
      if (this.closed) return;
      await peer.setLocalDescription(offer);
      if (this.closed) return;
      const offerSdp = peer.localDescription?.sdp ?? offer.sdp;
      if (!offerSdp) throw new Error("The microphone connection did not produce an offer.");
      const result = await this.deps.api.liveStart({ ...input, offerSdp });
      this.result = result;
      if (this.closed) {
        await this.deps.api.liveEnd(result.sessionId);
        return;
      }
      this.deps.onStarted(result);
      for (const value of this.providerQueue) this.forward(value);
      this.providerQueue = [];
      await peer.setRemoteDescription({ type: "answer", sdp: result.answerSdp });
      if (!this.closed) await this.admitMicrophone();
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  private forward(event: unknown): void {
    const result = this.result;
    if (!result) return;
    this.eventTail = this.eventTail.then(async () => {
      if (!this.closed) await this.deps.api.liveProviderEvent(result.sessionId, result.connectionEpoch, event);
    }).catch((error: unknown) => this.fail(error));
  }

  private async admitMicrophone(): Promise<void> {
    if (this.closed || this.admitted || this.readyPending || !this.providerStarted || !this.result) return;
    this.readyPending = true;
    const result = this.result;
    try {
      await this.eventTail;
      if (this.closed) return;
      await this.deps.api.liveReady(result.sessionId, result.connectionEpoch);
      if (this.closed) return;
      this.admitted = true;
      clearTimeout(this.timer);
      for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !this.muted;
      this.update({ connection: "ready", microphone: this.muted ? "muted" : "live" });
    } catch (error) {
      this.fail(error);
    } finally {
      this.readyPending = false;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.admitted || this.closed) return;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.update({ microphone: muted ? "muted" : "live" });
  }

  async resumePlayback(): Promise<void> {
    if (!this.audio || this.closed) return;
    try { await this.audio.play(); }
    catch { if (!this.closed) this.update({ playback: "blocked" }); }
  }

  /** Closing voice never cancels backend requests. */
  async end(): Promise<void> {
    if (this.closed) return;
    this.dispose();
    this.update({ connection: "closed", microphone: "off", playback: "off" });
    if (this.result) await this.deps.api.liveEnd(this.result.sessionId);
  }

  /** Main already ended or revoked this connection. Release media immediately. */
  release(): void {
    if (this.closed) return;
    this.dispose();
    this.update({ connection: "closed", microphone: "off", playback: "off" });
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.dispose();
    this.update({ connection: "failed", microphone: "off", playback: "off", error: error instanceof Error ? error.message : String(error) });
    if (this.result) void this.deps.api.liveEnd(this.result.sessionId).catch(() => undefined);
  }

  private dispose(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.providerQueue = [];
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.close();
    }
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    if (this.audio) {
      this.audio.onplaying = null;
      this.audio.onpause = null;
      this.audio.pause();
      const remote = this.audio.srcObject as MediaStream | null;
      for (const track of remote?.getTracks() ?? []) track.stop();
      this.audio.srcObject = null;
      this.audio.remove();
    }
  }
}
