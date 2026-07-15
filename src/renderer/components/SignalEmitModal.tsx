import { useRef, useState } from "react";
import type { TowerSignalPriority } from "@shared/ipc";
import { CANONICAL_ORBITS, isValidSignalKind, postTowerEmitSignal } from "../lib/browse";
import { DetailModal } from "./DetailModal";

// Typed emit form for Tower signals. Required fields match signal/v1 + the
// tower-cli emit surface; optional contract/payload/priority sit under the
// fold so a note can be thrown in with three fields.

const PRIORITIES: ReadonlyArray<TowerSignalPriority | ""> = ["", "low", "normal", "high", "urgent"];

export function SignalEmitModal({
  projectKey,
  defaultOrbit,
  orbits,
  onClose,
  onEmitted,
}: {
  readonly projectKey: string;
  readonly defaultOrbit?: string;
  /** Orbit choices (canonical + discovered). Falls back to CANONICAL_ORBITS. */
  readonly orbits?: ReadonlyArray<string>;
  readonly onClose: () => void;
  readonly onEmitted?: (signalId?: string) => void;
}) {
  const orbitChoices =
    orbits && orbits.length > 0
      ? orbits
      : (CANONICAL_ORBITS as ReadonlyArray<string>);
  const initialOrbit =
    defaultOrbit && orbitChoices.includes(defaultOrbit)
      ? defaultOrbit
      : (orbitChoices[0] ?? "forge");
  const [orbit, setOrbit] = useState(initialOrbit);
  const [kind, setKind] = useState("note");
  const [summary, setSummary] = useState("");
  const [contract, setContract] = useState("signal/v1");
  const [payloadJson, setPayloadJson] = useState("");
  const [priority, setPriority] = useState<TowerSignalPriority | "">("");
  const [dedupeKey, setDedupeKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string>();
  const [signalId, setSignalId] = useState<string>();
  // Sync guard: React state alone can double-fire before re-render.
  const sendingRef = useRef(false);

  const kindOk = isValidSignalKind(kind);
  const canSubmit =
    summary.trim().length > 0 &&
    kind.trim().length > 0 &&
    kindOk &&
    orbit.trim().length > 0 &&
    state !== "sending";

  const submit = async () => {
    if (!canSubmit || sendingRef.current) return;
    sendingRef.current = true;
    setState("sending");
    setError(undefined);
    const result = await postTowerEmitSignal({
      projectKey,
      orbit: orbit.trim(),
      kind: kind.trim(),
      summary,
      contractSchemaId: contract.trim() || undefined,
      payloadJson: payloadJson.trim() || undefined,
      priority: priority || undefined,
      dedupeKey: dedupeKey.trim() || undefined,
    });
    sendingRef.current = false;
    if (result.ok) {
      setState("sent");
      setSignalId(result.signalId);
      onEmitted?.(result.signalId);
    } else {
      setState("error");
      setError(result.error ?? "emit failed");
    }
  };

  return (
    <DetailModal onClose={onClose}>
      <div className="vellum-modal__eyebrow">signal / emit · {projectKey}</div>
      <div className="vellum-modal__title">Emit signal</div>
      <div className="vellum-modal__meta">routes into a project orbit inbox — not a glyph</div>

      <div className="vellum-modal__body">
        {state === "sent" ? (
          <div className="signal-emit__success">
            <div className="vellum-modal__paragraph">Signal emitted.</div>
            {signalId ? <div className="vellum-modal__line">id · {signalId}</div> : null}
            <div className="signal-emit__actions">
              <button type="button" className="canvas-dialog__submit" onClick={onClose}>done</button>
              <button
                type="button"
                className="canvas-dialog__cancel"
                onClick={() => {
                  setSummary("");
                  setPayloadJson("");
                  setDedupeKey("");
                  setState("idle");
                  setSignalId(undefined);
                  sendingRef.current = false;
                }}
              >
                emit another
              </button>
            </div>
          </div>
        ) : (
          <form
            className="signal-emit"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="signal-emit__field">
              <span>orbit</span>
              <select aria-label="Orbit" value={orbit} onChange={(event) => setOrbit(event.target.value)}>
                {orbitChoices.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>

            <label className="signal-emit__field">
              <span>kind</span>
              <input
                aria-label="Signal kind"
                aria-invalid={kind.trim().length > 0 && !kindOk}
                value={kind}
                onChange={(event) => { setKind(event.target.value); setState("idle"); }}
                placeholder="note"
                spellCheck={false}
              />
              {kind.trim().length > 0 && !kindOk ? (
                <span className="signal-emit__hint signal-emit__hint--error">
                  use lowercase segments, e.g. note or handoff.request
                </span>
              ) : (
                <span className="signal-emit__hint">lowercase · dots/underscores/hyphens ok</span>
              )}
            </label>

            <label className="signal-emit__field signal-emit__field--block">
              <span>summary</span>
              <textarea
                aria-label="Signal summary"
                className="signal-emit__summary"
                rows={5}
                autoFocus
                value={summary}
                onChange={(event) => { setSummary(event.target.value); setState("idle"); }}
                placeholder="What should the receiving orbit do?"
              />
            </label>

            <button
              type="button"
              className="signal-emit__advanced-toggle"
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((value) => !value)}
            >
              {showAdvanced ? "hide" : "show"} contract · payload · priority
            </button>

            {showAdvanced ? (
              <div className="signal-emit__advanced">
                <label className="signal-emit__field">
                  <span>contract</span>
                  <input
                    aria-label="Contract schema id"
                    value={contract}
                    onChange={(event) => setContract(event.target.value)}
                    placeholder="signal/v1"
                    spellCheck={false}
                  />
                </label>

                <label className="signal-emit__field">
                  <span>priority</span>
                  <select
                    aria-label="Priority"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value as TowerSignalPriority | "")}
                  >
                    {PRIORITIES.map((value) => (
                      <option key={value || "default"} value={value}>
                        {value || "default (normal)"}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="signal-emit__field">
                  <span>dedupe key</span>
                  <input
                    aria-label="Dedupe key"
                    value={dedupeKey}
                    onChange={(event) => setDedupeKey(event.target.value)}
                    placeholder="optional"
                    spellCheck={false}
                  />
                </label>

                <label className="signal-emit__field signal-emit__field--block">
                  <span>payload (json object)</span>
                  <textarea
                    aria-label="Payload JSON"
                    className="signal-emit__payload"
                    rows={4}
                    value={payloadJson}
                    onChange={(event) => { setPayloadJson(event.target.value); setState("idle"); }}
                    placeholder="{}"
                    spellCheck={false}
                  />
                </label>
              </div>
            ) : null}

            {state === "error" && error ? (
              <div className="vellum-modal__comment-status vellum-modal__comment-status--error">{error}</div>
            ) : null}

            <div className="signal-emit__actions">
              <button type="button" className="canvas-dialog__cancel" onClick={onClose}>cancel</button>
              <button type="submit" className="canvas-dialog__submit" disabled={!canSubmit}>
                {state === "sending" ? "emitting…" : "emit signal"}
              </button>
            </div>
          </form>
        )}
      </div>
    </DetailModal>
  );
}
