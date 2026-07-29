import type { CSSProperties } from "react";
import type { HostDeployJobSnapshot } from "@shared/ipc";
import { HUE } from "../../lib/theme";
import { Chip, type ChipTone } from "../ui";

const STATUS_TONE: Record<HostDeployJobSnapshot["status"], ChipTone> = {
  running: "amber",
  succeeded: "green",
  failed: "crimson",
  auth_required: "violet",
};

const STATUS_LABEL: Record<HostDeployJobSnapshot["status"], string> = {
  running: "deploying",
  succeeded: "ready",
  failed: "failed",
  auth_required: "password needed",
};

const barColor = (status: HostDeployJobSnapshot["status"]): string => {
  switch (status) {
    case "succeeded":
      return "#5FB98E";
    case "failed":
      return HUE.crimson;
    case "auth_required":
      return HUE.violet;
    default:
      return HUE.amber;
  }
};

function formatElapsed(startedAt: string, finishedAt?: string): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "";
  const end = finishedAt !== undefined ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(end)) return "";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

/**
 * Durable deploy progress for one host.
 * Data is main-owned; closing this panel does not stop the job.
 */
export function FleetDeployJobPanel({
  job,
  compact = false,
}: {
  readonly job: HostDeployJobSnapshot;
  readonly compact?: boolean;
}) {
  const elapsed = formatElapsed(job.startedAt, job.finishedAt);
  const percent = Math.max(0, Math.min(100, job.percent));
  const stages = job.stages;
  const latest = stages[stages.length - 1];

  return (
    <section
      className={`fleet-deploy-job${compact ? " fleet-deploy-job--compact" : ""}`}
      aria-live={job.status === "running" ? "polite" : "off"}
      aria-label={`Deploy job ${STATUS_LABEL[job.status]}`}
    >
      <div className="fleet-deploy-job__head">
        <span className="fleet-deploy-job__title">Progress</span>
        <Chip tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Chip>
        {elapsed ? (
          <span className="fleet-deploy-job__elapsed">{elapsed}</span>
        ) : null}
        {job.version ? (
          <span className="fleet-deploy-job__version">v{job.version}</span>
        ) : null}
      </div>

      <div
        className="fleet-deploy-job__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% — ${job.detail}`}
      >
        <div
          className="fleet-deploy-job__bar-fill"
          style={
            {
              width: `${percent}%`,
              background: barColor(job.status),
              opacity: job.status === "running" ? 0.95 : 0.85,
            } as CSSProperties
          }
        />
      </div>

      <p className="fleet-deploy-job__detail">{job.detail}</p>

      {!compact && stages.length > 0 ? (
        <details
          className="fleet-deploy-job__log"
          open={job.status === "running" || job.status === "failed"}
        >
          <summary>
            Step log · {stages.length} step{stages.length === 1 ? "" : "s"}
            {latest ? ` · latest: ${latest.slice(0, 48)}${latest.length > 48 ? "…" : ""}` : ""}
          </summary>
          <ol className="fleet-deploy-job__stages">
            {stages.map((stage, index) => (
              <li key={`${index}:${stage.slice(0, 24)}`}>
                <span className="fleet-deploy-job__stage-n">{index + 1}</span>
                <span>{stage}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}

      {job.recoveryHint && job.status !== "succeeded" ? (
        <p className="fleet-deploy-job__hint">
          recovery · {job.recoveryHint.replaceAll("-", " ")}
        </p>
      ) : null}

      {job.status === "running" ? (
        <p className="fleet-deploy-job__note">
          Running in Command Center main process. You can close this panel —
          deploy continues; reopen this machine to watch progress.
        </p>
      ) : null}
    </section>
  );
}
