import { SEAT_INSTRUCTIONS_MAX } from "@shared/seat-guidance";
import type { AgentEditorSectionProps } from "../agent-editor/sections";
import { GuidanceField } from "./GuidanceField";

// Instructions: standing instructions for this seat.

export function InstructionsSection({ seat }: AgentEditorSectionProps) {
  return (
    <GuidanceField
      seatId={seat.id}
      {...(seat.draft ? { draft: seat.draft } : {})}
      field="instructions"
      label="instructions"
      max={SEAT_INSTRUCTIONS_MAX}
      placeholder={"Run the tests before you call a task done.\nKeep commits small and say why in the message."}
    >
      Standing instructions for {seat.name}, on top of any region briefing. Markdown. They reach the agent at
      its next start and every time it runs <code>junto onboard</code>, whatever the harness. Where they clash
      with the Junto rules, the rules win and the agent asks you.
    </GuidanceField>
  );
}
