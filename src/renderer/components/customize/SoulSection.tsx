import { SEAT_SOUL_MAX } from "@shared/seat-guidance";
import type { AgentEditorSectionProps } from "../agent-editor/sections";
import { GuidanceField } from "./GuidanceField";

// Soul: who this agent is, in the operator's words.

export function SoulSection({ seat }: AgentEditorSectionProps) {
  return (
    <GuidanceField
      seatId={seat.id}
      {...(seat.draft ? { draft: seat.draft } : {})}
      field="soul"
      label="soul"
      max={SEAT_SOUL_MAX}
      placeholder="A careful reviewer. Speaks plainly, asks before guessing, and cares more about a green test run than a clever diff."
    >
      Who {seat.name} is: personality, voice, values. Markdown. It reaches the agent at its next start and
      every time it runs <code>junto onboard</code>, whatever the harness. The Junto rules still come first.
    </GuidanceField>
  );
}
