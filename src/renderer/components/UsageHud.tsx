import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { ProviderQuota, UsageSnapshot, UsageState, UsageWindow } from "@shared/usage";
import { worstWindow } from "@shared/usage";
import { state$ } from "../lib/state";
import { HUE } from "../lib/theme";
import { FocusSurface } from "./FocusSurface";
import "./UsageHud.css";

// Compact provider-usage rail: one [glyph|bar] cell per quota. No chrome
// labels, no pressure border. Hover = minimal provider · limit · %;
// click = document FocusSurface detail. Fail-open when nothing ok.

const EMPTY_USAGE: UsageState = { snapshots: [] };

const usageHue = (usedPercent: number): string => {
  if (usedPercent >= 85) return HUE.crimson;
  if (usedPercent >= 60) return HUE.amber;
  return "#5FB98E";
};

const rowKey = (snapshot: UsageSnapshot, quota: ProviderQuota, index: number): string =>
  `${snapshot.source}:${quota.provider}:${quota.source}:${quota.account ?? ""}:${index}`;

const visibleQuotas = (
  state: UsageState,
): ReadonlyArray<{ snapshot: UsageSnapshot; quota: ProviderQuota; index: number }> => {
  const rows: Array<{ snapshot: UsageSnapshot; quota: ProviderQuota; index: number }> = [];
  for (const snapshot of state.snapshots) {
    if (!snapshot.ok) continue;
    for (const [index, quota] of snapshot.quotas.entries()) {
      rows.push({ snapshot, quota, index });
    }
  }
  return rows;
};

// Short limit tag for glance copy — never pace essays or reset prose walls.
const shortLimit = (window: UsageWindow | undefined): string => {
  if (!window) return "—";
  if (window.title && window.title.length <= 18) return window.title;
  if (window.windowMinutes !== undefined) {
    const m = window.windowMinutes;
    if (m <= 60) return `${m}m`;
    if (m <= 24 * 60) return `${Math.round(m / 60)}h`;
    if (m <= 8 * 24 * 60) return `${Math.round(m / (24 * 60))}d`;
    return "weekly";
  }
  return window.label;
};

const formatPercent = (value: number): string => `${Math.round(value)}%`;

const providerLabel = (quota: ProviderQuota): string => {
  // Disambiguate multi-account same provider (e.g. two Codex logins).
  if (quota.account) {
    const local = quota.account.includes("@") ? quota.account.split("@")[0]! : quota.account;
    if (local.length > 0 && local.length <= 14) return `${quota.provider} · ${local}`;
  }
  return quota.provider;
};

const glyph = (quota: ProviderQuota): string => {
  const name = quota.provider.trim();
  return name.length > 0 ? name[0]!.toUpperCase() : "?";
};

function Cell({ quota }: { readonly quota: ProviderQuota }) {
  if (quota.status === "error") {
    return (
      <span className="usage-hud__cell is-error" title={`${quota.provider}: error`}>
        <span className="usage-hud__glyph">{glyph(quota)}</span>
        <span className="usage-hud__bar" />
      </span>
    );
  }
  const worst = worstWindow(quota);
  const used = worst?.usedPercent ?? 0;
  const hue = usageHue(used);
  return (
    <span className="usage-hud__cell" title={`${quota.provider} ${formatPercent(used)}`}>
      <span className="usage-hud__glyph">{glyph(quota)}</span>
      <span className="usage-hud__bar">
        <i style={{ width: `${Math.min(100, Math.max(0, used))}%`, background: hue }} />
      </span>
    </span>
  );
}

function Tooltip({
  rows,
}: {
  readonly rows: ReadonlyArray<{ quota: ProviderQuota }>;
}) {
  return (
    <div className="usage-hud__tooltip" role="tooltip">
      {rows.map(({ quota }, i) => {
        const worst = worstWindow(quota);
        const limit =
          quota.status === "error" ? "error" : shortLimit(worst);
        const pct =
          quota.status === "error" ? "—" : formatPercent(worst?.usedPercent ?? 0);
        const color =
          quota.status === "error" ? HUE.crimson : usageHue(worst?.usedPercent ?? 0);
        return (
          <div key={`${quota.provider}:${quota.account ?? ""}:${i}`} className="usage-hud__tooltip-row">
            <strong>{providerLabel(quota)}</strong>
            <span>{limit}</span>
            <em style={{ color }}>{pct}</em>
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
          <div className="usage-hud-detail__provider">{providerLabel(quota)}</div>
          <div className="usage-hud-detail__plan">
            {[quota.source, quota.plan].filter(Boolean).join(" · ") || "—"}
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
            <div
              key={`${window.label}:${window.id ?? ""}:${window.title ?? ""}`}
              className="usage-hud-detail__window"
            >
              <div className="usage-hud-detail__window-meta">
                <span>{shortLimit(window)}</span>
                <strong style={{ color: hue }}>{formatPercent(window.usedPercent)}</strong>
              </div>
              <div className="usage-hud-detail__bar">
                <i
                  style={{
                    width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
                    background: hue,
                  }}
                />
              </div>
              {window.resetDescription ? (
                <div className="usage-hud-detail__pace">{window.resetDescription}</div>
              ) : null}
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
  const footerFetched =
    state.snapshots.find((snapshot) => snapshot.ok)?.fetchedAt ?? state.snapshots[0]?.fetchedAt;

  return (
    <FocusSurface measure="document" height="resizable" layer="detail" label="Limits" onClose={onClose}>
      <div className="usage-hud-detail">
        <header className="usage-hud-detail__header">
          <div>
            <div className="usage-hud-detail__eyebrow">limits</div>
            <strong>Providers</strong>
          </div>
          <button type="button" aria-label="Close limits" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="usage-hud-detail__body">
          {rows.length === 0 ? (
            <div className="usage-hud-detail__error">No quotas available.</div>
          ) : (
            rows.map(({ quota, snapshot, index }) => (
              <DetailCard key={rowKey(snapshot, quota, index)} quota={quota} />
            ))
          )}
        </div>
        <footer className="usage-hud-detail__footer">
          <span>codexbar</span>
          <span>{footerFetched ? footerFetched.slice(0, 16).replace("T", " ") : "—"}</span>
        </footer>
      </div>
    </FocusSurface>
  );
}

export function UsageHud() {
  const usage = use$(state$.usage);
  const state = usage ?? EMPTY_USAGE;
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);

  const rows = useMemo(() => visibleQuotas(state), [state]);
  if (rows.length === 0) return null;

  return (
    <>
      <div
        className="usage-hud"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          type="button"
          className="usage-hud__rail"
          aria-label="Provider limits"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {rows.map(({ quota, snapshot, index }) => (
            <Cell key={rowKey(snapshot, quota, index)} quota={quota} />
          ))}
        </button>
        {hover && !open ? <Tooltip rows={rows} /> : null}
      </div>
      {open ? <UsageDetail state={state} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
