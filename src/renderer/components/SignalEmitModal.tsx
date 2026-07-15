import { useState } from "react";
import type { TowerSignalPriority } from "@shared/ipc";
import { CANONICAL_ORBITS, postTowerEmitSignal } from "../lib/browse";
import { DetailModal } from "./DetailModal";

// Typed emit form for Tower signals. Required fields match signal/v1 + the
// tower-cli emit surface; optional contract/payload/priority sit under the
// fold so a note can be thrown in with three fields.

const PRIORITIES: ReadonlyArray<TowerSignalPriority | ""> = ["", "low", "normal", "high", "urgent"];

export function SignalEmitModal({
  projectKey,
  defaultOrbit,
  onClose,
  onEmitted,
}: {
  readonly projectKey: string;
  readonly defaultOrbit?: string;
  readonly onClose: () => void;
  readonly onEmitted?: (signalId: string) => void;
}) {
  const initialOrbit =
    defaultOrbit && (CANONICAL_ORBITS as ReadonlyArray<string>).includes(defaultOrbit)
      ? defaultOrbit
      : "forge";
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

  const canSubmit = summary.trim().length > 0 && kind.trim().length > 0 && orbit.trim().length > 0 && state !== "sending";

  const submit = async () => {
    if (!canSubmit) return;
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
    if (result.ok) {
      setState("sent");
      setSignalId(result.signalId);
      if (result.signalId) onEmitted?.(result.signalId);
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
                {CANONICAL_ORBITS.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>

            <label className="signal-emit__field">
              <span>kind</span>
              <input
                aria-label="Signal kind"
                autoFocus
                value={kind}
                onChange={(event) => { setKind(event.target.value); setState("idle"); }}
                placeholder="note"
                spellCheck={false}
              />
            </label>

            <label className="signal-emit__field signal-emit__field--block">
              <span>summary</span>
              <textarea
                aria-label="Signal summary"
                className="signal-emit__summary"
                rows={5}
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
