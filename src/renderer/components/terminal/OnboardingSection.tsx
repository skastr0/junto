/**
 * Onboarding section of the seat sidebar: whether this seat's agent has run
 * `junto onboard` in the session it is running now, and a button that types
 * the one-sentence nudge when the operator chooses.
 *
 * Junto sends nothing at session start and nudges on its own at most twice,
 * so a seat that lost track (a compaction, a long session) shows here and is
 * the operator's to point back. The button goes through the same gate as
 * every typed prompt: a busy seat or a draft refuses it and says why.
 */
import { useState } from "react";
import type { CanvasNode } from "@shared/canvas";
import { SEAT_ONBOARDING_LABEL } from "@shared/seat-onboarding-status";
import { sendOnboardNudge, useSeatOnboarding } from "../../lib/seat-onboarding";
import { Button, SidebarSection, StatusDot } from "../ui";

export function OnboardingSection({ node }: { readonly node: CanvasNode }) {
  const status = useSeatOnboarding(node);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  if (status === undefined) return null;

  const nudge = async () => {
    setSending(true);
    setSent(false);
    setProblem(undefined);
    const result = await sendOnboardNudge(node.id);
    setSending(false);
    if (result.ok) setSent(true);
    else setProblem(result.message);
  };

  const onboarded = status === "onboarded";
  return (
    <SidebarSection storageKey="seat-sidebar:onboarding" title="onboarding" testId="seat-onboarding-section">
      <div className="flex items-center gap-2" data-onboarding={status}>
        <StatusDot tone={onboarded ? "green" : "dim"} />
        <span className="font-mono text-body-lg text-ink">{SEAT_ONBOARDING_LABEL[status]}</span>
        <Button
          size="xs"
          className="ml-auto"
          disabled={sending}
          onClick={() => void nudge()}
          data-testid="seat-onboarding-nudge"
        >
          {onboarded ? "Nudge again" : "Send nudge"}
        </Button>
      </div>
      <p className="mt-1.5 text-label leading-snug text-faint">
        {onboarded
          ? "The agent ran junto onboard in this session. Nudge again if it has lost track of its seat."
          : "The agent has not run junto onboard in this session. The nudge is one sentence asking it to."}
      </p>
      {sent ? (
        <p className="mt-1 text-label leading-snug text-dim" role="status">
          Nudge sent.
        </p>
      ) : null}
      {problem ? (
        <p className="mt-1 text-label leading-snug text-amber" role="alert">
          {problem}
        </p>
      ) : null}
    </SidebarSection>
  );
}
