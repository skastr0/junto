import type { AgentEditorSectionProps } from "../agent-editor/sections";
import { OffboardControls } from "./OffboardControls";
import "./sessions.css";

// A seat's sessions are internal to the seat: its history, notes and
// transcripts live in its own store and CLI, never here. What stays is asking
// the agent to offboard.

export function SessionsSection({ seat }: AgentEditorSectionProps) {
  return (
    <div className="seat-sessions" data-testid="seat-sessions-section">
      <OffboardControls seatId={seat.id} />
    </div>
  );
}
