import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Play, RefreshCw, Square } from "lucide-react";
import type {
  BoxAvailabilityResult,
  BoxFleetResource,
} from "@shared/ipc";
import { getVellumApi } from "../../lib/vellum-api";
import { Button, Chip, StatusDot } from "../ui";

const BOX_DASHBOARD_URL = "https://box.ascii.dev/box/dashboard";

const stateTone = (state: string): "green" | "amber" | "steel" =>
  state === "stopped"
    ? "steel"
    : state === "running" || state === "idle" || state === "ready"
      ? "green"
      : "amber";

export function FleetBoxPanel({
  onClose,
  onFleetChanged,
}: {
  readonly onClose: () => void;
  readonly onFleetChanged: () => Promise<void>;
}) {
  const [availability, setAvailability] =
    useState<BoxAvailabilityResult | null>(null);
  const [boxes, setBoxes] = useState<ReadonlyArray<BoxFleetResource>>([]);
  const [busy, setBusy] = useState<string | null>("loading");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const api = getVellumApi();
    if (!api?.boxAvailability || !api.boxListOwned) {
      setMessage("Box integration is unavailable in this build.");
      setBusy(null);
      return;
    }
    setBusy("loading");
    try {
      const [status, owned] = await Promise.all([
        api.boxAvailability(),
        api.boxListOwned(),
      ]);
      setAvailability(status);
      setBoxes(owned.ok ? [...(owned.boxes ?? [])] : []);
      if (!owned.ok) setMessage(owned.message ?? "Could not read owned Boxes.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const api = getVellumApi();
    if (!api?.boxCreate) return;
    setBusy("create");
    setMessage("");
    try {
      const result = await api.boxCreate();
      if (!result.ok) {
        setMessage(result.message ?? "Box creation failed.");
        return;
      }
      setMessage("Box created and enrolled in Command Fleet.");
      await Promise.all([load(), onFleetChanged()]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const operate = async (
    operation: "refresh" | "stop" | "resume",
    boxId: string,
  ) => {
    const api = getVellumApi();
    const invoke =
      operation === "refresh"
        ? api?.boxRefresh
        : operation === "stop"
          ? api?.boxStop
          : api?.boxResume;
    if (!invoke) return;
    setBusy(`${operation}:${boxId}`);
    setMessage("");
    try {
      const result = await invoke(boxId);
      if (!result.ok) {
        setMessage(result.message ?? `Box ${operation} failed.`);
        return;
      }
      if (result.box) {
        setBoxes((current) =>
          current.map((box) =>
            box.boxId === result.box!.boxId ? result.box! : box,
          ),
        );
      }
      await onFleetChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const ready =
    availability?.available === true &&
    availability.authenticated &&
    availability.healthy;

  return (
    <div className="fleet-form-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="fleet-box-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Box fleet provider"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="fleet-box-panel__header">
          <div>
            <div className="fleet-box-panel__eyebrow">optional provider</div>
            <h2>Box CLI</h2>
            <p>
              Your Box account, credentials, and billing stay with Box. Vellum
              controls only machines it creates and records locally.
            </p>
          </div>
          <Button size="sm" variant="subtle" onClick={onClose}>
            close
          </Button>
        </header>

        <div className="fleet-box-panel__provider">
          <StatusDot
            tone={ready ? "green" : availability?.available ? "amber" : "dim"}
          />
          <div>
            <strong>
              {availability === null
                ? "Detecting Box CLI…"
                : availability.detail}
            </strong>
            <span>
              {availability?.executable ??
                "Expected at ~/.ascii/bin/box or on PATH"}
            </span>
          </div>
          <div className="fleet-box-panel__provider-actions">
            <Button
              size="xs"
              variant="subtle"
              disabled={busy !== null}
              onClick={() => void load()}
            >
              <RefreshCw size={11} />
              Detect
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() =>
                window.open(BOX_DASHBOARD_URL, "_blank", "noopener,noreferrer")
              }
            >
              <ExternalLink size={11} />
              Dashboard
            </Button>
          </div>
        </div>

        {!availability?.available ? (
          <div className="fleet-box-panel__notice">
            Install Box using its official installer, then reopen this panel.
            Vellum also checks the official <code>~/.ascii/bin/box</code> path.
          </div>
        ) : !availability.authenticated ? (
          <div className="fleet-box-panel__notice">
            Authenticate in your terminal with <code>box login</code>. Vellum
            does not receive or store the credential.
          </div>
        ) : null}

        <div className="fleet-box-panel__toolbar">
          <div>
            <strong>Vellum-created Boxes</strong>
            <span>{boxes.length} locally owned</span>
          </div>
          <Button
            size="sm"
            variant="primary"
            disabled={!ready || busy !== null}
            onClick={() => void create()}
          >
            {busy === "create" ? "Creating…" : "New Box"}
          </Button>
        </div>

        <div className="fleet-box-panel__list">
          {boxes.length === 0 ? (
            <div className="fleet-box-panel__empty">
              No Vellum-created Boxes. Existing machines in your Box account
              are intentionally invisible here.
            </div>
          ) : (
            boxes.map((box) => {
              const stopped = box.state === "stopped";
              const transitioning =
                box.state === "stopping" ||
                box.state === "resuming" ||
                box.state === "provisioning";
              const boxBusy = busy?.endsWith(`:${box.boxId}`) === true;
              return (
                <article key={box.boxId} className="fleet-box-card">
                  <div className="fleet-box-card__identity">
                    <StatusDot tone={stateTone(box.state)} />
                    <div>
                      <strong>{box.name}</strong>
                      <span>
                        {box.boxId} · {box.ip ?? "address unavailable"}
                      </span>
                    </div>
                  </div>
                  <Chip tone={stateTone(box.state)}>{box.state}</Chip>
                  <div className="fleet-box-card__actions">
                    <Button
                      size="xs"
                      variant="subtle"
                      disabled={boxBusy}
                      onClick={() => void operate("refresh", box.boxId)}
                    >
                      <RefreshCw size={11} />
                      Refresh
                    </Button>
                    <Button
                      size="xs"
                      variant={stopped ? "primary" : "chrome"}
                      disabled={boxBusy || transitioning}
                      onClick={() =>
                        void operate(stopped ? "resume" : "stop", box.boxId)
                      }
                    >
                      {stopped ? <Play size={11} /> : <Square size={10} />}
                      {transitioning ? "Wait" : stopped ? "Resume" : "Stop"}
                    </Button>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <footer className="fleet-box-panel__footer">
          <span>
            New Boxes use your Box account defaults and secrets. Vellum disables
            automatic stop so a Station can remain available.
          </span>
          <span>Delete machines and manage billing in the Box dashboard.</span>
        </footer>

        {message ? (
          <p className="fleet-box-panel__message" role="status">
            {message}
          </p>
        ) : null}
      </section>
    </div>
  );
}
