import { useEffect, useState, type ReactNode } from "react";
import { Pencil, UserRoundPen } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { isHarnessId } from "@shared/managed-terminal-templates";
import {
  agentEditor$,
  agentEditorAnchor,
  closeAgentEditor,
  openAgentEditor,
  toggleAgentEditor,
} from "../../lib/agent-editor-state";
import { isAgentSeatNode } from "../../lib/multi-selection";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { AgentPortrait } from "../AgentPortrait";
import { InspectorTabs } from "../chat/InspectorTabs";
import { Eyebrow, IconButton, Popover } from "../ui";
import { CharacterDraftProvider, useCharacterDraft } from "./character-draft";
import { AGENT_EDITOR_SECTIONS, type AgentEditorSeat } from "./sections";
import "./AgentEditor.css";

// Customize agent: one place for everything the operator sets on a seat, as
// sections (look, mood, name, and whatever lands next). The hero keeps the
// seat's character in view whichever section is open.

function Hero({ seat }: { readonly seat: AgentEditorSeat }) {
  const { draft, saveFailed } = useCharacterDraft();
  return (
    <div className="agent-editor__hero">
      <AgentPortrait identity={seat.id} size={72} frame="round" config={draft} harness={seat.harness} />
      <div className="agent-editor__hero-side">
        <Eyebrow tone="steel">customize agent</Eyebrow>
        <div className="agent-editor__name" title={seat.name}>
          {seat.name}
        </div>
        <div className="agent-editor__meta">
          {saveFailed ? (
            <span className="agent-editor__error">Could not save this character.</span>
          ) : (
            <span>{seat.harness ? `${seat.harness} seat` : "agent seat"}, kept on this install</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The editor itself, without the popover: hero, section tabs, one panel.
 * Renders inline anywhere (the onboarding tour shows it with a fixture
 * seat). `section` picks the open section and follows later changes; the
 * tabs still switch it.
 */
export function AgentEditorView({ seat, section }: { readonly seat: AgentEditorSeat; readonly section?: string }) {
  const sections = AGENT_EDITOR_SECTIONS.filter((entry) => entry.applies?.(seat) ?? true);
  const [active, setActive] = useState(section ?? "");
  useEffect(() => {
    if (section) setActive(section);
  }, [section]);
  const current = sections.find((entry) => entry.id === active) ?? sections[0];
  return (
    <CharacterDraftProvider identity={seat.id}>
      <div className="agent-editor">
        <Hero seat={seat} />
        <InspectorTabs
          label="Customize sections"
          tabs={sections.map(({ id, label }) => ({ id, label }))}
          active={current?.id ?? ""}
          onSelect={setActive}
        />
        <div className="agent-editor__panel" role="tabpanel" aria-label={current?.label} data-section={current?.id}>
          {current ? <current.Panel key={current.id} seat={seat} /> : null}
        </div>
      </div>
    </CharacterDraftProvider>
  );
}

export function AgentEditor({
  seat,
  anchor,
  section,
  onClose,
}: {
  readonly seat: AgentEditorSeat;
  readonly anchor: HTMLElement;
  readonly section?: string;
  readonly onClose: () => void;
}) {
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={`Customize ${seat.name}`}
      width={480}
      className="agent-editor-popover"
      testId="agent-editor"
    >
      <AgentEditorView seat={seat} section={section} />
    </Popover>
  );
}

/** The seat the editor edits, read live off the canvas. */
const seatOf = (seatId: string): AgentEditorSeat | undefined => {
  const node = state$.doc.nodes.get().find((candidate) => candidate.id === seatId);
  if (!node || !isAgentSeatNode(node)) return undefined;
  const harness = node.ether?.terminal?.harness;
  return {
    id: node.id,
    node,
    name: nodeTitle(node),
    ...(typeof harness === "string" && isHarnessId(harness) ? { harness } : {}),
  };
};

/**
 * Mounted once at the app root: renders the editor wherever it was opened.
 * Closes itself when the seat leaves the canvas.
 */
export function AgentEditorHost() {
  const open = use$(agentEditor$);
  const seat = use$(() => (open ? seatOf(open.seatId) : undefined));
  const [fallback, setFallback] = useState<HTMLElement | null>(null);
  if (!open) return null;
  const anchor = agentEditorAnchor(open.seatId) ?? fallback;
  return (
    <>
      {/* Where the editor sits when neither its opener nor the seat is on screen. */}
      <div ref={setFallback} className="agent-editor-fallback-anchor" aria-hidden />
      {seat && anchor ? (
        <AgentEditor key={`${seat.id}:${open.opened}`} seat={seat} anchor={anchor} section={open.section} onClose={closeAgentEditor} />
      ) : null}
    </>
  );
}

/**
 * Makes a portrait (or a ringed seat) a button that opens the editor. With
 * `hint`, hover and keyboard focus show a pencil and a "Customize" tag so the
 * portrait reads as editable.
 */
export function CustomizeAgentButton({
  identity,
  name,
  hint = false,
  children,
}: {
  readonly identity: string;
  readonly name: string;
  readonly hint?: boolean;
  /** The trigger's face, e.g. a SeatRing. */
  readonly children: ReactNode;
}) {
  const expanded = use$(() => agentEditor$.get()?.seatId === identity);
  return (
    <button
      type="button"
      className="customize-agent-button"
      data-hint={hint ? "true" : undefined}
      aria-label={`Customize ${name}`}
      aria-expanded={expanded}
      title={hint ? undefined : "Customize character"}
      data-testid="customize-agent-button"
      onClick={(event) => toggleAgentEditor(identity, { anchor: event.currentTarget })}
    >
      {children}
      {hint ? (
        <>
          <span className="customize-agent-button__pencil" aria-hidden>
            <Pencil size={10} strokeWidth={2.4} />
          </span>
          <span className="customize-agent-button__tag" aria-hidden>
            Customize
          </span>
        </>
      ) : null}
    </button>
  );
}

/** The seat toolbar's entry: opens the editor beside the seat. */
export function CustomizeAgentToolbarAction({ seatId }: { readonly seatId: string }) {
  return (
    <IconButton
      className="nodrag nopan"
      aria-label="Customize character"
      title="Customize character (look, mood, name)"
      data-testid="toolbar-customize-agent"
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openAgentEditor(seatId);
      }}
    >
      <UserRoundPen size={14} />
    </IconButton>
  );
}
