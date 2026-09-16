import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { ProviderQuota, UsageSnapshot, UsageState, UsageWindow } from "@shared/usage";
import { worstWindow } from "@shared/usage";
import { state$ } from "../lib/state";
import { GREEN, HUE } from "../lib/theme";
import { FocusSurface } from "./FocusSurface";
import { HarnessMark } from "./HarnessMark";
import "./UsageHud.css";

// Compact station usage rail: one [glyph / bar] cell per quota (vertical
// split — icon above meter). Sources are the native strategy meters.
// Fail open: paint only when there are quotas; hide entirely when no source
// reports data or the poll has nothing to show (no loading/error chrome).

const EMPTY_USAGE: UsageState = { snapshots: [] };

const usageHue = (usedPercent: number): string => {
  if (usedPercent >= 85) return HUE.crimson;
  if (usedPercent >= 60) return HUE.amber;
  return GREEN;
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

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
};

/** Token/cost readout from extras when plan windows are absent. */
const tokenSummary = (
  quota: ProviderQuota,
): { readonly totalTokens?: number; readonly costUsd?: number; readonly note?: string } => {
  const extras = quota.extras;
  if (extras === undefined) return {};
  return {
    totalTokens: asFiniteNumber(extras.totalTokens),
    costUsd: asFiniteNumber(extras.costUsd),
    note: typeof extras.note === "string" ? extras.note : undefined,
  };
};

const providerLabel = (quota: ProviderQuota): string => {
  // Disambiguate multi-account same provider (e.g. two Codex logins).
  if (quota.account) {
    const local = quota.account.includes("@") ? quota.account.split("@")[0]! : quota.account;
    if (local.length > 0 && local.length <= 14) return `${quota.provider} - ${local}`;
  }
  return quota.provider;
};

/** Rail / list / detail mark — never native title (fights the hover panel). */
const ProviderMark = ({ provider, size }: { readonly provider: string; readonly size: number }) => (
  <HarnessMark agent={provider} size={size} title={false} />
);

function Cell({ quota }: { readonly quota: ProviderQuota }) {
  const mark = <ProviderMark provider={quota.provider} size={12} />;
  if (quota.status === "error") {
    return (
      <span className="usage-hud__cell is-error">
        {mark}
        <span className="usage-hud__bar" />
      </span>
    );
  }
  const worst = worstWindow(quota);
  if (worst !== undefined) {
    const used = worst.usedPercent;
    const hue = usageHue(used);
    return (
      <span className="usage-hud__cell">
        {mark}
        <span className="usage-hud__bar">
          <i style={{ width: `${Math.min(100, Math.max(0, used))}%`, background: hue }} />
        </span>
      </span>
    );
  }
  // Token-only / no plan %: same icon+bar geometry as percent cells. Empty
  // track (not a fake %) — absolute token totals live in the hover list + detail.
  const tokens = tokenSummary(quota);
  if (tokens.totalTokens !== undefined) {
    return (
      <span className="usage-hud__cell is-tokens">
        {mark}
        <span className="usage-hud__bar" />
      </span>
    );
  }
  return (
    <span className="usage-hud__cell is-empty">
      {mark}
      <span className="usage-hud__bar" />
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
        const tokens = tokenSummary(quota);
        const limit =
          quota.status === "error"
            ? "error"
            : worst !== undefined
              ? shortLimit(worst)
              : tokens.totalTokens !== undefined
                ? "7d tokens"
                : "—";
        const pct =
          quota.status === "error"
            ? "—"
            : worst !== undefined
              ? formatPercent(worst.usedPercent)
              : tokens.totalTokens !== undefined
                ? formatTokens(tokens.totalTokens)
                : "—";
        const color =
          quota.status === "error"
            ? HUE.crimson
            : worst !== undefined
              ? usageHue(worst.usedPercent)
              : HUE.amber;
        return (
          <div key={`${quota.provider}:${quota.account ?? ""}:${i}`} className="usage-hud__tooltip-row">
            <span className="usage-hud__tooltip-name">
              <ProviderMark provider={quota.provider} size={14} />
              <strong>{providerLabel(quota)}</strong>
            </span>
            <span>{limit}</span>
            <em style={{ color }}>{pct}</em>
          </div>
        );
      })}
    </div>
  );
}

function DetailCard({ quota }: { readonly quota: ProviderQuota }) {
  const tokens = tokenSummary(quota);
  const billingMode =
    quota.extras !== undefined && typeof quota.extras.billingMode === "string"
      ? quota.extras.billingMode
      : undefined;
  const costTicks =
    quota.extras !== undefined ? asFiniteNumber(quota.extras.costUsdTicks) : undefined;
  return (
    <article className={`usage-hud-detail__card${quota.status === "error" ? " is-error" : ""}`}>
      <header className="usage-hud-detail__card-head">
        <div className="usage-hud-detail__identity">
          <ProviderMark provider={quota.provider} size={22} />
          <div>
            <div className="usage-hud-detail__provider">{providerLabel(quota)}</div>
            <div className="usage-hud-detail__plan">
              {[quota.source, quota.plan, billingMode].filter(Boolean).join(" - ") || "—"}
            </div>
          </div>
        </div>
        {quota.creditsRemaining !== undefined ? (
          <div className="usage-hud-detail__credits">{quota.creditsRemaining} credits</div>
        ) : tokens.costUsd !== undefined && tokens.costUsd > 0 ? (
          <div className="usage-hud-detail__credits">${tokens.costUsd.toFixed(2)}</div>
        ) : null}
      </header>
      {quota.status === "error" ? (
        <div className="usage-hud-detail__error">{quota.error ?? "provider error"}</div>
      ) : quota.windows.length > 0 ? (
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
      ) : (
        <div className="usage-hud-detail__window">
          <div className="usage-hud-detail__window-meta">
            <span>7d tokens</span>
            <strong style={{ color: HUE.amber }}>
              {tokens.totalTokens !== undefined ? formatTokens(tokens.totalTokens) : "—"}
            </strong>
          </div>
          {tokens.totalTokens !== undefined ? (
            <div className="usage-hud-detail__pace">
              in {formatTokens(asFiniteNumber(quota.extras?.inputTokens) ?? 0)} - out{" "}
              {formatTokens(asFiniteNumber(quota.extras?.outputTokens) ?? 0)}
              {costTicks !== undefined && costTicks > 0 ? ` - cost ticks ${formatTokens(costTicks)}` : ""}
            </div>
          ) : null}
          {tokens.note ? <div className="usage-hud-detail__pace">{tokens.note}</div> : null}
        </div>
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

  return (
    <FocusSurface
      measure="document"
      height="fit"
      layer="detail"
      label="Providers"
      panelClassName="usage-hud-detail-panel"
      onClose={onClose}
    >
      <div className="usage-hud-detail">
        <header className="usage-hud-detail__header">
          <strong>Providers</strong>
          <button type="button" aria-label="Close providers" onClick={onClose}>
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
  const stale = state.stale === true;

  // Fail open: no quotas → no chrome (missing CLI, empty poll, first boot).
  if (rows.length === 0) return null;

  // Accessible name only — never `title` (Electron paints a native bubble that
  // sits on top of the custom hover list).
  const a11yLabel = stale
    ? `Provider limits, stale${state.lastLiveAt ? ` - ${state.lastLiveAt.slice(0, 16).replace("T", " ")}` : ""}`
    : "Provider limits";

  return (
    <>
      <div
        className={`usage-hud${stale ? " is-stale" : ""}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <button
          type="button"
          className="usage-hud__rail"
          aria-label={a11yLabel}
          aria-expanded={open}
          onClick={() => {
            setHover(false);
            setOpen(true);
          }}
        >
          {stale ? <span className="usage-hud__stale-dot" aria-hidden /> : null}
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
