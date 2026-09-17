/**
 * SeatAwarenessHover — the operator-facing face of the advisory sidecar.
 *
 * A leaf: given the canonical deterministic status and an optional awareness
 * assessment it renders attribution, the code-composed label, the extractive
 * terminal excerpt, and freshness. It reads no store, mutates nothing, and has
 * no effects — in particular it never marks a seat seen, so hovering can never
 * clear `needsLook` or change the canvas.
 *
 * Two planes, never merged:
 *   control  the existing deterministic status (StatusDot + label + detail),
 *            echoed unchanged. Canonical attention wins at presentation and is
 *            never downgraded by an AI answer.
 *   AI       an attributed, hedged suggestion or likelihood. It never reads as
 *            a control transition and never promises that delivery paused.
 *
 * With no assessment (or an abstained/failed one) the control plane still
 * renders and the AI plane degrades to a neutral or honest line. The excerpt is
 * inert text from the evidence window captured for that observation — bounded,
 * sanitized on ingest, never a link, never an instruction.
 */

import type { ReactNode } from "react";
import type { SeatAwarenessAssessment } from "../../lib/seat-awareness-contract";
import {
  SEAT_AWARENESS_AVAILABILITY_TONE,
  SEAT_AWARENESS_EXCERPT_LABEL,
  SEAT_AWARENESS_TERMINAL_ATTRIBUTION,
  seatAwarenessView,
  type SeatAwarenessControl,
  type SeatAwarenessLiveWindow,
} from "../../lib/seat-awareness";
import { Chip, Eyebrow, OverlayHeader, StatusDot } from "../ui";

export function SeatAwarenessHover({
  bindingId,
  control,
  assessment,
  window,
  now,
  className,
}: {
  /** Binding the assessment belongs to — carried for tests and provenance. */
  readonly bindingId?: string | undefined;
  /** Canonical deterministic status. Awareness never replaces it. */
  readonly control: SeatAwarenessControl;
  readonly assessment?: SeatAwarenessAssessment | undefined;
  /** Live evidence revision, so an excerpt from an older screen reads stale. */
  readonly window?: SeatAwarenessLiveWindow | undefined;
  readonly now?: number | undefined;
  readonly className?: string | undefined;
}): ReactNode {
  const view = seatAwarenessView({
    control,
    assessment,
    window,
    now: now ?? Date.now(),
  });

  return (
    <section
      role="tooltip"
      aria-label={view.sentence}
      data-seat-awareness={view.availability}
      data-awareness-binding={bindingId}
      data-awareness-control-state={view.control.state}
      data-awareness-attention={view.canonicalAttention ? "true" : undefined}
      data-awareness-ai-label={view.aiLabel ?? undefined}
      data-awareness-judgment={view.judgmentFreshness ?? undefined}
      data-awareness-excerpt={view.excerptFreshness ?? undefined}
      className={[
        "w-[320px] overflow-hidden rounded-md border border-stroke bg-raise shadow-lg shadow-black/40",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <OverlayHeader
        eyebrow={view.attribution ?? SEAT_AWARENESS_TERMINAL_ATTRIBUTION}
        title={
          <span className="flex items-center gap-1.5">
            <StatusDot tone={view.control.tone} pulse={view.control.pulse} />
            <span className="truncate">{view.control.label}</span>
          </span>
        }
        status={view.control.detail}
        actions={
          <Chip tone={SEAT_AWARENESS_AVAILABILITY_TONE[view.availability]}>
            {view.availabilityLabel}
          </Chip>
        }
      />
      <div className="flex flex-col gap-2 px-3.5 py-2.5">
        {view.aiLabel ? (
          <div className="flex flex-col gap-1">
            <p className="text-[12px] leading-snug text-ink">{view.aiLabel}</p>
            {view.concernTexts.length > 1 ? (
              <div className="flex flex-wrap gap-1">
                {view.concernTexts.slice(1).map((text) => (
                  <Chip key={text} tone="steel">
                    {text}
                  </Chip>
                ))}
              </div>
            ) : null}
            {view.freshness ? (
              <p className="text-[10px] tabular-nums text-faint">{view.freshness}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-dim">{view.availabilityLine}</p>
        )}
        {view.excerpt ? (
          <div className="border-t border-stroke pt-2">
            <Eyebrow tone="faint" size="xs">
              {view.excerptLabel ?? SEAT_AWARENESS_EXCERPT_LABEL}
            </Eyebrow>
            <p className="mt-0.5 break-words font-mono text-[11px] leading-snug text-ink">
              {view.excerpt}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
