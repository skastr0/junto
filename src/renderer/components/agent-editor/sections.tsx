import type { ComponentType } from "react";
import type { CanvasNode } from "@shared/canvas";
import { LookSection } from "./LookSection";
import { MoodSection } from "./MoodSection";
import { NameSection } from "./NameSection";

/**
 * The customize-agent editor's sections, in tab order. This list is the
 * extension point: a new section is one entry here and a panel component in
 * its owner's files. Each panel saves its own edits as they happen; there is
 * no editor-wide Save. Open one directly with
 * `openAgentEditor(seatId, { section: "<id>" })`.
 */

export interface AgentEditorSeat {
  readonly id: string;
  readonly node: CanvasNode;
  /** The seat's name as the operator reads it. */
  readonly name: string;
  /** Harness id for a managed seat. */
  readonly harness?: string;
}

export interface AgentEditorSectionProps {
  readonly seat: AgentEditorSeat;
}

export interface AgentEditorSection {
  readonly id: string;
  /** Tab label, lowercase, one or two words. */
  readonly label: string;
  readonly Panel: ComponentType<AgentEditorSectionProps>;
  /** Absent means every agent seat. */
  readonly applies?: (seat: AgentEditorSeat) => boolean;
}

export const AGENT_EDITOR_SECTIONS: ReadonlyArray<AgentEditorSection> = [
  { id: "look", label: "look", Panel: LookSection },
  { id: "mood", label: "mood", Panel: MoodSection },
  { id: "name", label: "name", Panel: NameSection },
];
