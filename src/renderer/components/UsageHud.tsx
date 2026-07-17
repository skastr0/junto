import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Gauge } from "lucide-react";
import type { ProviderQuota, UsageSnapshot, UsageState, UsageWindow } from "@shared/usage";
import { worstWindow } from "@shared/usage";
import { state$ } from "../lib/state";
import { HUE, withAlpha } from "../lib/theme";
import { FocusSurface } from "./FocusSurface";
import "./UsageHud.css";

// RTS-style provider usage readout. Fail-open: renders null when every
// snapshot is ok:false or empty (codexbar absent / all sources down).
// Collapsed pill sits top-left on the canvas stage; click opens a document
// FocusSurface with per-provider windows, pace, resets, and credits.

const EMPTY_USAGE: UsageState = { snapshots: [] };

const usageHue = (usedPercent: number): string => {
  if (usedPercent >= 85) return HUE.crimson;
  if (usedPercent >= 60) return HUE.amber;
  return "#5FB98E";
};

const visibleQuotas = (state: UsageState): ReadonlyArray<{ snapshot: UsageSnapshot; quota: ProviderQuota }> => {
  const rows: Array<{ snapshot: UsageSnapshot; quota: ProviderQuota }> = [];
  for (const snapshot of state.snapshots) {
    if (!snapshot.ok) continue;
    for (const quota of snapshot.quotas) {
      rows.push({ snapshot, quota });
    }
  }
  return rows;
};

const windowTitle = (window: UsageWindow): string =>
  window.title ?? window.id ?? window.label;

const formatPercent = (value: number): string => `${Math.round(value)}%`;

function Segment({ quota }: { readonly quota: ProviderQuota }) {
  if (quota.status === "error") {
    return (
      <span
        className="usage-hud__segment is-error"
        title={`${quota.provider}: ${quota.error ?? "error"}`}
      />
    );
  }
  const worst = worstWindow(quota);
  const used = worst?.usedPercent ?? 0;
  const hue = usageHue(used);
  return (
    <span
      className="usage-hud__segment"
      title={`${quota.provider} · ${formatPercent(used)}${worst?.resetDescription ? ` · ${worst.resetDescription}` : ""}`}
    >
      <i className="usage-hud__fill" style={{ width: `${Math.min(100, Math.max(0, used))}%`, background: hue }} />
    </span>
  );
}

function Tooltip({ rows }: { readonly rows: ReadonlyArray<{ quota: ProviderQuota }> }) {
  return (
    <div className="usage-hud__tooltip" role="tooltip">
      {rows.map(({ quota }) => {
        const worst = worstWindow(quota);
        return (
          <div key={`${quota.provider}:${quota.source}`} className="usage-hud__tooltip-row">
            <strong>{quota.provider}</strong>
            <span>
              {quota.status === "error"
                ? quota.error ?? "error"
                : worst
                  ? `${windowTitle(worst)}${worst.resetDescription ? ` · ${worst.resetDescription}` : ""}`
                  : "no windows"}
            </span>
            <em style={{ color: quota.status === "error" ? HUE.crimson : usageHue(worst?.usedPercent ?? 0) }}>
              {quota.status === "error" ? "—" : formatPercent(worst?.usedPercent ?? 0)}
            </em>
          </div>
        );
      })}
    </div>
  );
}

function DetailCard({ quota }: { readonly quota: ProviderQuota }) {
  return (
    <article className={`usage-hud-detail__card${quota.status === "error" ? " is-error" : ""}`}>
      <header className="usage-hud-detail__card-head">
        <div>
          <div className="usage-hud-detail__provider">{quota.provider}</div>
          <div className="usage-hud-detail__plan">
            {[quota.plan, quota.source, quota.account].filter(Boolean).join(" · ") || quota.source}
          </div>
        </div>
        {quota.creditsRemaining !== undefined ? (
          <div className="usage-hud-detail__credits">{quota.creditsRemaining} credits</div>
        ) : null}
      </header>
      {quota.status === "error" ? (
        <div className="usage-hud-detail__error">{quota.error ?? "provider error"}</div>
      ) : (
        quota.windows.map((window) => {
          const hue = usageHue(window.usedPercent);
          return (
            <div key={`${window.label}:${window.id ?? ""}:${window.title ?? ""}`} className="usage-hud-detail__window">
              <div className="usage-hud-detail__window-meta">
                <span>{windowTitle(window)}</span>
                <strong style={{ color: hue }}>{formatPercent(window.usedPercent)}</strong>
              </div>
              <div className="usage-hud-detail__bar">
                <i style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%`, background: hue }} />
              </div>
              <div className="usage-hud-detail__pace">
                {window.resetDescription
                  ? `resets ${window.resetDescription}`
                  : window.resetsAt
                    ? `resets ${window.resetsAt}`
                    : "reset unknown"}
                {window.pace?.summary ? ` · ${window.pace.summary}` : ""}
              </div>
            </div>
          );
        })
      )}
    </article>
  );
}

function UsageDetail({
  state,
  onClose,
}: {
  readonly state: UsageState;
  readonly onClose: () => void;
}) {
  const rows = visibleQuotas(state);
  const footerSource = state.snapshots.find((snapshot) => snapshot.ok)?.source ?? state.snapshots[0]?.source;
  const footerFetched =
    state.snapshots.find((snapshot) => snapshot.ok)?.fetchedAt ?? state.snapshots[0]?.fetchedAt;

  return (
    <FocusSurface measure="document" height="resizable" layer="detail" label="Provider usage" onClose={onClose}>
      <div className="usage-hud-detail">
        <header className="usage-hud-detail__header">
          <div>
            <div className="usage-hud-detail__eyebrow">provider usage</div>
            <strong>Resource limits</strong>
          </div>
          <button type="button" aria-label="Close provider usage" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="usage-hud-detail__body">
          {rows.length === 0 ? (
            <div className="usage-hud-detail__error">No provider quotas available.</div>
          ) : (
            rows.map(({ quota, snapshot }) => (
              <DetailCard key={`${snapshot.source}:${quota.provider}:${quota.source}`} quota={quota} />
            ))
          )}
        </div>
        <footer className="usage-hud-detail__footer">
          <span>{footerSource ?? "—"}</span>
          <span>{footerFetched ? `fetched ${footerFetched}` : "not yet fetched"}</span>
        </footer>
      </div>
    </FocusSurface>
  );
}

export function UsageHud() {
  const usage = use$(state$.usage) as UsageState | undefined;
  const state = usage ?? EMPTY_USAGE;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  const rows = useMemo(() => visibleQuotas(state), [state]);
  if (rows.length === 0) return null;

  const okCount = rows.filter(({ quota }) => quota.status === "ok").length;
  const worstOverall = rows.reduce<number>((acc, { quota }) => {
    if (quota.status !== "ok") return acc;
    const used = worstWindow(quota)?.usedPercent ?? 0;
    return used > acc ? used : acc;
  }, 0);

  return (
    <>
      <div
        className="usage-hud"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          type="button"
          className="usage-hud__pill"
          aria-label="Provider usage"
          title="Provider usage"
          onClick={() => setOpen(true)}
          style={{ borderColor: withAlpha(usageHue(worstOverall), 0.35) }}
        >
          <Gauge className="usage-hud__icon" size={14} strokeWidth={1.75} />
          <div className="usage-hud__meta">
            <div className="usage-hud__eyebrow">usage</div>
            <div className="usage-hud__title">
              {okCount}/{rows.length}
            </div>
          </div>
          <div className="usage-hud__segments" aria-hidden="true">
            {rows.map(({ quota, snapshot }) => (
              <Segment key={`${snapshot.source}:${quota.provider}:${quota.source}`} quota={quota} />
            ))}
          </div>
        </button>
        {hover && !open ? <Tooltip rows={rows} /> : null}
      </div>
      {open ? <UsageDetail state={state} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
