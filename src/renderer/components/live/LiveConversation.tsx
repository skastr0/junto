import { useCallback, useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Mic, MicOff, Minimize2, PhoneOff, Square, Volume2, X } from "lucide-react";
import type { LiveSnapshot, LiveStartResult } from "@shared/overseer-live";
import { FocusSurface } from "../FocusSurface";
import { Button, Chip, FieldLabel, IconButton, Input, OverlayHeader } from "../ui";
import { OverseerLiveMedia, type LiveMediaState } from "../../lib/overseer-live-media";
import { overseerLive$, readLiveAttention, type LiveSeatTarget } from "../../lib/overseer-live-state";
import { state$ } from "../../lib/state";
import { openSettings } from "../../lib/settings-state";
import { liveSettings } from "@shared/settings";
import "./live-conversation.css";

const IDLE_MEDIA: LiveMediaState = { connection: "idle", microphone: "off", playback: "off" };
const terminalRequest = (status: string): boolean => ["completed", "cancelled", "superseded", "failed"].includes(status);
const duration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Stays mounted while the operator returns to the canvas to select subjects. */
export function LiveConversationHost() {
  const target = use$(overseerLive$.target);
  return target ? <LiveConversation key={`${target.canvasName}/${target.nodeId}`} target={target} /> : null;
}

function LiveConversation({ target }: { readonly target: LiveSeatTarget }) {
  const expanded = use$(overseerLive$.expanded);
  const canvasName = use$(state$.canvasName);
  const selectedNodeId = use$(state$.selectedNodeId);
  const selectedNodeIds = use$(state$.selectedNodeIds);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [media, setMedia] = useState<LiveMediaState>(IDLE_MEDIA);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mediaRef = useRef<OverseerLiveMedia | null>(null);
  const connectionRef = useRef<LiveStartResult | null>(null);
  const mounted = useRef(true);
  const sessionId = snapshot?.sessionId;
  const callActive = media.connection === "ready" || media.connection === "connecting";

  const receiveSnapshot = useCallback((next: LiveSnapshot) => {
    if (!mounted.current || next.canvasName !== target.canvasName || next.nodeId !== target.nodeId) return;
    const own = connectionRef.current;
    if (own && next.connectionEpoch < own.connectionEpoch) return;
    setSnapshot(next);
    if (own && next.sessionId === own.sessionId && next.connectionEpoch === own.connectionEpoch &&
      (next.authority === "revoked" || next.connection === "closed" || next.connection === "disconnected")) {
      mediaRef.current?.release();
    }
  }, [target.canvasName, target.nodeId]);

  useEffect(() => {
    mounted.current = true;
    const api = window.vellumCommand;
    const unsubscribe = api?.onLiveChanged(receiveSnapshot);
    void api?.liveSnapshot().then(receiveSnapshot).catch((caught: unknown) => {
      if (mounted.current) setError(errorText(caught));
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
      void mediaRef.current?.end().catch(() => undefined);
    };
  }, [receiveSnapshot]);

  useEffect(() => {
    if (!sessionId || !canvasName) return;
    const attention = readLiveAttention();
    const timer = setTimeout(() => {
      void window.vellumCommand?.liveAttention(sessionId, attention).catch((caught: unknown) => {
        if (mounted.current) setError(errorText(caught));
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [sessionId, canvasName, selectedNodeId, selectedNodeIds]);

  const start = () => {
    const api = window.vellumCommand;
    if (!api || callActive) return;
    const settings = state$.settings.peek();
    if (!settings.providers?.openai?.apiKeyConfigured || !liveSettings(settings).backendModel.trim()) {
      setError("Add your OpenAI API key and backend model in Settings > Providers before starting a call.");
      return;
    }
    setError("");
    connectionRef.current = null;
    const control = new OverseerLiveMedia({
      api,
      getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
      createPeer: () => new RTCPeerConnection(),
      createAudio: () => new Audio(),
      onState: (next) => { if (mounted.current) setMedia(next); },
      onStarted: (result) => {
        connectionRef.current = result;
        receiveSnapshot(result.snapshot);
      },
    });
    mediaRef.current = control;
    void control.start({ canvasName: target.canvasName, nodeId: target.nodeId, attention: readLiveAttention() });
  };

  const end = () => {
    void mediaRef.current?.end().catch((caught: unknown) => {
      if (mounted.current) setError(errorText(caught));
    });
  };
  const run = async (action: () => Promise<LiveSnapshot>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try { receiveSnapshot(await action()); }
    catch (caught) { if (mounted.current) setError(errorText(caught)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggleMute = () => mediaRef.current?.setMuted(media.microphone !== "muted");
  const minimize = () => overseerLive$.expanded.set(false);
  const close = () => {
    end();
    overseerLive$.target.set(null);
    overseerLive$.expanded.set(false);
  };

  if (!expanded) {
    return (
      <aside className="live-call-rail" aria-label="Live conversation controls" data-focus-owner="interactive">
        <Button size="md" variant="subtle" onClick={() => overseerLive$.expanded.set(true)}>
          <Mic size={14} aria-hidden /> {target.title}
          <span className="text-dim">{callActive ? media.microphone === "muted" ? "Muted" : "Live conversation" : "Call ended"}</span>
        </Button>
        {callActive ? <>
          <IconButton aria-label={media.microphone === "muted" ? "Unmute microphone" : "Mute microphone"} disabled={media.connection !== "ready"} onClick={toggleMute}>
            {media.microphone === "muted" ? <MicOff size={14} /> : <Mic size={14} />}
          </IconButton>
          <IconButton aria-label="End call, keep requests" onClick={end}><PhoneOff size={14} /></IconButton>
        </> : <IconButton aria-label="Close live conversation" onClick={close}><X size={14} /></IconButton>}
      </aside>
    );
  }

  return (
    <FocusSurface measure="document" height="resizable" label="Live conversation" onClose={minimize} panelClassName="live-conversation">
      <OverlayHeader
        eyebrow="Overseer conversation"
        title={target.title}
        status={`${target.canvasName} / GPT-Live-1`}
        actions={<>
          <IconButton aria-label="Return to canvas, keep call" onClick={minimize}><Minimize2 size={15} /></IconButton>
          {!callActive && <IconButton aria-label="Close live conversation" onClick={close}><X size={15} /></IconButton>}
        </>}
      />
      <LiveConversationBody
        snapshot={snapshot} media={media} error={error || media.error || ""} busy={busy}
        onStart={start} onMute={toggleMute} onEnd={end}
        onSettings={() => { minimize(); openSettings(); }}
        onPlayback={() => { void mediaRef.current?.resumePlayback(); }}
        onStop={() => { if (sessionId) void run(() => window.vellumCommand!.liveStopActions(sessionId)); }}
        onCancel={(requestId) => { if (sessionId) void run(() => window.vellumCommand!.liveCancel(sessionId, requestId)); }}
        onSteer={(requestId, text) => { if (sessionId) void run(() => window.vellumCommand!.liveSteer(sessionId, requestId, text, readLiveAttention())); }}
      />
    </FocusSurface>
  );
}

export function LiveConversationBody({ snapshot, media, error, busy, onStart, onMute, onEnd, onSettings, onPlayback, onStop, onCancel, onSteer }: {
  readonly snapshot: LiveSnapshot | null;
  readonly media: LiveMediaState;
  readonly error: string;
  readonly busy: boolean;
  readonly onStart: () => void;
  readonly onMute: () => void;
  readonly onEnd: () => void;
  readonly onSettings: () => void;
  readonly onPlayback: () => void;
  readonly onStop: () => void;
  readonly onCancel: (requestId: string) => void;
  readonly onSteer: (requestId: string, text: string) => void;
}) {
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const active = media.connection === "ready" || media.connection === "connecting";
  const requests = snapshot?.requests ?? [];
  const pending = requests.filter((request) => !terminalRequest(request.status));
  const controller = snapshot?.controller ?? "idle";
  const cost = snapshot?.voiceCostUsd ?? 0;
  const elapsed = snapshot?.elapsedSeconds ?? 0;
  const limit = snapshot?.limitSeconds;
  return <>
    <div className="live-conversation__status" role="status" aria-live="polite">
      <Chip tone={media.microphone === "live" ? "amber" : "steel"}>
        {media.microphone === "live" ? "Microphone on" : media.microphone === "waiting" ? "Microphone waiting" : media.microphone === "muted" ? "Microphone muted" : "Microphone off"}
      </Chip>
      <Chip tone="steel">{media.playback === "playing" ? "Audio on" : media.playback === "blocked" ? "Audio needs attention" : "Audio idle"}</Chip>
      <Chip tone={controller === "idle" ? "steel" : "amber"}>{controller === "waiting-approval" ? "Awaiting approval" : controller === "working" ? "Taking action" : controller === "interpreting" ? "Interpreting" : "Controller idle"}</Chip>
    </div>
    {error || snapshot?.message ? <div className="live-conversation__notice"><p role="alert">{error || snapshot?.message}</p>{error.includes("Settings > Providers") && <Button size="md" onClick={onSettings}>Open settings</Button>}</div> : null}
    <div className="live-conversation__scroll">
      <section aria-label="Conversation transcript">
        <h2 className="live-conversation__heading">Conversation</h2>
        {snapshot?.transcript.length ? <ol className="live-conversation__transcript" role="log" aria-live="polite" aria-relevant="additions text">
          {snapshot.transcript.map((entry) => <li key={entry.id}>
            <span className="live-conversation__speaker">{entry.speaker === "operator" ? "You" : "Overseer"}</span>
            <p>{entry.text}</p>
          </li>)}
        </ol> : <p className="live-conversation__empty">{active ? "Speak when the microphone is on. Your conversation will appear here." : "Talk through the canvas with your Overseer. Return to the canvas during a call to select what you want to discuss."}</p>}
      </section>
      <section aria-label="Overseer requests">
        <div className="live-conversation__section-head">
          <h2 className="live-conversation__heading">Requests</h2>
          <span className="text-dim text-[11px]">{pending.length ? `${pending.length} in progress` : "No pending requests"}</span>
        </div>
        {requests.length ? <ol className="live-conversation__requests">
          {requests.map((request) => <li key={request.requestId}>
            <div className="live-conversation__request-heading"><p>{request.text}</p><Chip tone={request.status === "failed" ? "crimson" : "steel"}>{request.status.replaceAll("-", " ")}</Chip></div>
            {!terminalRequest(request.status) && <div className="live-conversation__request-controls">
              <Button size="xs" disabled={busy || snapshot?.authority !== "active"} onClick={() => { setCorrecting(request.requestId); setCorrection(""); }}>Correct request</Button>
              <Button size="xs" disabled={busy} onClick={() => onCancel(request.requestId)}>Cancel request</Button>
            </div>}
            {correcting === request.requestId && !terminalRequest(request.status) && <form className="live-conversation__correction" onSubmit={(event) => {
              event.preventDefault();
              const text = correction.trim();
              if (!text || busy) return;
              onSteer(request.requestId, text);
              setCorrecting(null);
              setCorrection("");
            }}>
              <FieldLabel>Correction for this request<Input id="live-request-correction" value={correction} maxLength={4000} placeholder="What should change?" onChange={(event) => setCorrection(event.target.value)} /></FieldLabel>
              <Button type="submit" size="md" disabled={!correction.trim() || busy}>Send</Button>
            </form>}
          </li>)}
        </ol> : <p className="live-conversation__empty">Requested changes and their outcomes appear here. Speaking or muting does not cancel a request.</p>}
      </section>
      {(snapshot?.actions.length ?? 0) > 0 && <section aria-label="Action history">
        <h2 className="live-conversation__heading">Action history</h2>
        <ol className="live-conversation__actions">{snapshot!.actions.map((action) => <li key={action.id}>
          <div className="live-conversation__request-heading"><span>{action.label}</span><span className="text-dim">{action.status}</span></div>
          {action.targetRefs.length > 0 && <p className="text-dim break-all text-[11px]">{action.targetRefs.join(", ")}</p>}
        </li>)}</ol>
      </section>}
    </div>
    <footer className="live-conversation__footer">
      <div className="live-conversation__meter">
        <span>{duration(elapsed)}{limit ? ` / ${duration(limit)} call limit` : " elapsed"}</span>
        <span title="Voice estimate only; controller and worker usage are billed separately.">Voice estimate ${cost.toFixed(3)}</span>
      </div>
      {limit ? <progress className="live-conversation__progress" aria-label="Call time used" value={Math.min(elapsed, limit)} max={limit} /> : null}
      <div className="live-conversation__buttons">
        {active ? <>
          <Button size="md" onClick={onMute} disabled={media.connection !== "ready"} aria-pressed={media.microphone === "muted"}>
            {media.microphone === "muted" ? <MicOff size={14} /> : <Mic size={14} />}{media.microphone === "muted" ? "Unmute" : "Mute"}
          </Button>
          <Button size="md" onClick={onEnd}><PhoneOff size={14} />End call</Button>
        </> : <Button size="md" variant="primary" onClick={onStart} disabled={snapshot?.authority === "revoked"}><Mic size={14} />Start live conversation</Button>}
        {media.playback === "blocked" && <Button size="md" onClick={onPlayback}><Volume2 size={14} />Enable audio</Button>}
        <Button size="md" variant="danger" disabled={busy || !snapshot?.sessionId || snapshot.authority !== "active" || snapshot.actionsStopped === true} onClick={onStop}><Square size={12} />{snapshot?.actionsStopped ? "Actions stopped" : "Stop actions"}</Button>
      </div>
      <p className="live-conversation__hint">{active ? "End call stops the microphone and voice. Pending requests continue; cancel a request or stop actions separately." : pending.length ? "The call is closed. Pending requests continue and can still be corrected or cancelled." : "The microphone activates only after you start a call. Voice is sent to OpenAI."}</p>
    </footer>
  </>;
}
