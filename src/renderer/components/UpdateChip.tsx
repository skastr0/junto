import { use$ } from "@legendapp/state/react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "./ui";
import {
  restartAndInstallUpdate,
  updateState$,
} from "../lib/update-state";

/**
 * Deep-field chrome chip: surfaces when an update is ready or installing.
 * Explicit "Restart to update" only — never auto-installs on quit.
 */
export function UpdateChip() {
  const status = use$(updateState$.status);
  const busy = use$(updateState$.busy);

  if (
    status.phase !== "ready" &&
    status.phase !== "installing" &&
    status.phase !== "downloading" &&
    status.phase !== "available"
  ) {
    return null;
  }

  if (status.phase === "downloading" || status.phase === "available") {
    const percent =
      status.progress !== undefined
        ? Math.round(status.progress.percent)
        : undefined;
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-dim"
        role="status"
        aria-live="polite"
        title={
          status.available
            ? `Downloading ${status.available.version}`
            : "Downloading update"
        }
      >
        <Download size={12} aria-hidden />
        {percent === undefined ? "update…" : `${percent}%`}
      </span>
    );
  }

  const version = status.available?.version;
  const installing = status.phase === "installing";

  return (
    <Button
      variant="primary"
      size="sm"
      disabled={busy || installing}
      title={
        version
          ? `Restart to install Vellum Command ${version}`
          : "Restart to install the downloaded update"
      }
      aria-label={
        version
          ? `Restart to update to version ${version}`
          : "Restart to update"
      }
      onClick={() => {
        void restartAndInstallUpdate();
      }}
    >
      <RefreshCw size={12} aria-hidden className={installing ? "animate-spin" : undefined} />
      {installing
        ? "installing…"
        : version
          ? `Restart to update - ${version}`
          : "Restart to update"}
    </Button>
  );
}
