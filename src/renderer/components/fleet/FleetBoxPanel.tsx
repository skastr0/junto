import { use$ } from "@legendapp/state/react";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Play, RefreshCw, Square } from "lucide-react";
import {
  boxAvailabilityNeedsRefresh,
  boxFleet$,
  cacheBoxAvailability,
  cacheOwnedBoxes,
  invalidateBoxAvailability,
  invalidateOwnedBoxes,
  ownedBoxesNeedRefresh,
  upsertCachedBox,
} from "../../lib/box-fleet-state";
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
  const availability = use$(boxFleet$.availability);
  const availabilityValid = use$(boxFleet$.availabilityValid);
  const boxes = use$(boxFleet$.boxes);
  const [busy, setBusy] = useState<string | null>(() =>
    boxAvailabilityNeedsRefresh() || ownedBoxesNeedRefresh()
      ? "loading"
      : null
  );
  const [message, setMessage] = useState("");

  const refreshAvailability = useCallback(async (force = false) => {
    const api = getVellumApi();
    if (!api?.boxAvailability) {
      invalidateBoxAvailability();
      setMessage("Box integration is unavailable in this build.");
      return;
    }
    try {
      if (!force && !boxAvailabilityNeedsRefresh()) return;
      const status = await api.boxAvailability();
      if (!status.ok) {
        invalidateBoxAvailability();
        setMessage(status.message ?? status.detail);
        return;
      }
      cacheBoxAvailability(status);
    } catch (cause) {
      invalidateBoxAvailability();
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshOwnedBoxes = useCallback(async (force = false) => {
    const api = getVellumApi();
    if (!api?.boxListOwned) {
      invalidateOwnedBoxes();
      setMessage("Box integration is unavailable in this build.");
      return;
    }
    try {
      if (!force && !ownedBoxesNeedRefresh()) return;
      const owned = await api.boxListOwned();
      if (!owned.ok) {
        invalidateOwnedBoxes();
        setMessage(owned.message ?? "Could not read owned Boxes.");
        return;
      }
      cacheOwnedBoxes(owned.boxes ?? []);
    } catch (cause) {
      invalidateOwnedBoxes();
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadMissing = useCallback(async () => {
    const needsAvailability = boxAvailabilityNeedsRefresh();
    const needsBoxes = ownedBoxesNeedRefresh();
    if (!needsAvailability && !needsBoxes) {
      setBusy(null);
      return;
    }
    setBusy(
      boxFleet$.availability.peek() === null &&
        boxFleet$.boxes.peek().length === 0
        ? "loading"
        : null
    );
    await Promise.all([
      needsAvailability ? refreshAvailability() : Promise.resolve(),
      needsBoxes ? refreshOwnedBoxes() : Promise.resolve(),
    ]);
    setBusy(null);
  }, [refreshAvailability, refreshOwnedBoxes]);

  useEffect(() => {
    void loadMissing();
  }, [loadMissing]);

  const refreshFleetView = async () => {
    try {
      await onFleetChanged();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setMessage((current) =>
        `${current}${current ? " " : ""}Fleet view refresh failed: ${detail}`
      );
    }
  };

  const create = async () => {
    const api = getVellumApi();
    if (!api?.boxCreate) return;
    setBusy("create");
    setMessage("");
    try {
      const result = await api.boxCreate();
      if (!result.ok) {
        invalidateOwnedBoxes();
        const recovery =
          result.recoveryBoxId && result.provisioningStage
            ? ` Box ${result.recoveryBoxId} exists; retry from stage ${result.provisioningStage}.`
            : "";
        setMessage(`${result.message ?? "Box creation failed."}${recovery}`);
        await Promise.all([refreshOwnedBoxes(), refreshFleetView()]);
        return;
      }
      if (result.box) {
        upsertCachedBox(result.box);
      } else {
        invalidateOwnedBoxes();
        await refreshOwnedBoxes();
      }
      setMessage("Box created, SSH verified, and enrolled in Command Fleet.");
      await refreshFleetView();
    } catch (cause) {
      invalidateOwnedBoxes();
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const operate = async (
    operation: "refresh" | "prepare" | "stop" | "resume",
    boxId: string,
  ) => {
    const api = getVellumApi();
    const invoke =
      operation === "refresh"
        ? api?.boxRefresh
        : operation === "prepare"
          ? api?.boxPrepareSsh
          : operation === "stop"
            ? api?.boxStop
            : api?.boxResume;
    if (!invoke) return;
    setBusy(`${operation}:${boxId}`);
    setMessage("");
    try {
      const result = await invoke(boxId);
      if (!result.ok) {
        invalidateOwnedBoxes();
        setMessage(result.message ?? `Box ${operation} failed.`);
        return;
      }
      if (result.box) {
        upsertCachedBox(result.box);
      } else {
        invalidateOwnedBoxes();
        await refreshOwnedBoxes();
      }
      await refreshFleetView();
    } catch (cause) {
      invalidateOwnedBoxes();
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const ready =
    availabilityValid &&
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
            tone={
              ready
                ? "green"
                : availability?.available
                  ? "amber"
                  : "dim"
            }
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
              onClick={() => {
                setBusy("detect");
                setMessage("");
                void refreshAvailability(true).finally(() => setBusy(null));
              }}
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
              const providerSshUsable =
                box.ip !== null &&
                (box.state === "ready" ||
                  box.state === "idle" ||
                  box.state === "running");
              const routeReady = box.sshVerifiedAt !== undefined;
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
                  <Chip tone={routeReady ? "green" : "amber"}>
                    {routeReady
                      ? "SSH verified"
                      : box.sshPreparedAt
                        ? "SSH needs verification"
                        : "SSH not prepared"}
                  </Chip>
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
                    {!routeReady && providerSshUsable ? (
                      <Button
                        size="xs"
                        variant="primary"
                        disabled={boxBusy}
                        onClick={() =>
                          void operate("prepare", box.boxId)
                        }
                      >
                        <Play size={11} />
                        Prepare SSH
                      </Button>
                    ) : null}
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
            New Boxes use your Box account defaults and secrets. Active work
            keeps its Box available; when the Box has no active work, Vellum
            arms Box&apos;s 10-minute automatic stop.
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
