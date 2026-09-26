import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, UserRoundPen, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { isHarnessId } from "@shared/managed-terminal-templates";
import {
  agentEditor$,
  closeAgentEditor,
  openAgentEditor,
} from "../../lib/agent-editor-state";
import { isAgentSeatNode } from "../../lib/multi-selection";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { AgentPortrait } from "../AgentPortrait";
import { FocusSurface } from "../FocusSurface";
import { InspectorTabs } from "../chat/InspectorTabs";
import { Button, IconButton, OverlayHeader } from "../ui";
import { CharacterDraftProvider, isEmptyConfig, useCharacterDraft } from "./character-draft";
import { randomLook } from "./LookSection";
import { AGENT_EDITOR_SECTIONS, type AgentEditorSeat } from "./sections";
import "./AgentEditor.css";

// Customize agent: one place for everything the operator sets on a seat, as
// sections (look, mood, name, and whatever lands next), in a modal. The stage
// keeps the whole character in view, large, whichever section is open, and
// shows whatever option or mood is hovered before it is picked.

const STAGE_PX = 280;

function Stage({ seat }: { readonly seat: AgentEditorSeat }) {
  const { draft, preview, replace, saveFailed } = useCharacterDraft();
  const lookChanged = !isEmptyConfig({ ...draft, temperament: undefined });
  return (
    <div className="agent-editor__stage">
      <div className="agent-editor__plate" data-previewing={preview ? "true" : undefined}>
        <AgentPortrait
          identity={seat.id}
          size={STAGE_PX}
          frame="bare"
          badge={false}
          outline={false}
          config={preview?.config ?? draft}
          {...(preview?.expression ? { expression: preview.expression } : {})}
        />
      </div>
      <div className="agent-editor__caption" aria-live="polite" data-tone={saveFailed ? "error" : undefined}>
        {preview ? preview.label : saveFailed ? "Could not save this character." : "Hover an option to try it on."}
      </div>
      <div className="agent-editor__stage-actions">
        <Button size="sm" variant="chrome" onClick={() => replace(randomLook(draft.temperament))}>
          Randomize look
        </Button>
        <Button
          size="sm"
          variant="subtle"
          disabled={!lookChanged}
          title={`Back to the look ${seat.name} was born with`}
          onClick={() => replace({ temperament: draft.temperament })}
        >
          Reset look
        </Button>
      </div>
    </div>
  );
}

/**
 * The editor body without the modal: the stage beside the section tabs and
 * one panel. Renders inline anywhere (the onboarding tour shows it with a
 * fixture seat); below ~720px wide the stage stacks above the sections.
 * `section` picks the open section and follows later changes; the tabs still
 * switch it.
 */
export function AgentEditorView({ seat, section }: { readonly seat: AgentEditorSeat; readonly section?: string }) {
  const sections = AGENT_EDITOR_SECTIONS.filter((entry) => entry.applies?.(seat) ?? true);
  const [active, setActive] = useState(section ?? "");
  useEffect(() => {
    if (section) setActive(section);
  }, [section]);
  const current = sections.find((entry) => entry.id === active) ?? sections[0];
  return (
    <CharacterDraftProvider identity={seat.id} {...(seat.draft ? { store: seat.draft } : {})}>
      <div className="agent-editor-frame">
        <div className="agent-editor">
          <Stage seat={seat} />
          <div className="agent-editor__sections">
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
        </div>
      </div>
    </CharacterDraftProvider>
  );
}

export function AgentEditor({
  seat,
  section,
  eyebrow = "customize agent",
  status,
  footer,
  onClose,
}: {
  readonly seat: AgentEditorSeat;
  readonly section?: string;
  readonly eyebrow?: string;
  /** Under the title; defaults to the seat's harness and how edits save. */
  readonly status?: string;
  /** Below the sections, e.g. a draft's save actions. */
  readonly footer?: ReactNode;
  readonly onClose: () => void;
}) {
  // Escape belongs to this modal while it is open: a surface under it (the
  // focus view it was opened from) must not close too. The close waits a
  // microtask so the Name field's own Escape listener still sees the key.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      queueMicrotask(() => onCloseRef.current());
    };
    // focus-law: Escape-only close of the open customize modal.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
  return (
    <FocusSurface
      measure="document"
      height="fit"
      layer="work"
      label={`Customize ${seat.name}`}
      panelClassName="agent-editor-modal"
      closeOnEscape={false}
      onClose={onClose}
    >
      <div data-testid="agent-editor" className="agent-editor-modal__body" aria-label={`Customize ${seat.name}`}>
        <OverlayHeader
          eyebrow={eyebrow}
          title={seat.name}
          status={status ?? `${seat.harness ? `${seat.harness} seat` : "agent seat"}, saved on this install as you go`}
          actions={
            <IconButton aria-label="Close customize" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />
        <AgentEditorView seat={seat} section={section} />
        {footer}
      </div>
    </FocusSurface>
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
 * Mounted once at the app root: renders the editor for whichever seat asked.
 * Closes itself when the seat leaves the canvas.
 */
export function AgentEditorHost() {
  const open = use$(agentEditor$);
  const seat = use$(() => (open ? seatOf(open.seatId) : undefined));
  if (!open || !seat) return null;
  return <AgentEditor key={`${seat.id}:${open.opened}`} seat={seat} section={open.section} onClose={closeAgentEditor} />;
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
      aria-haspopup="dialog"
      aria-expanded={expanded}
      title={hint ? undefined : "Customize character"}
      data-testid="customize-agent-button"
      onClick={() => openAgentEditor(identity)}
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

/** The seat toolbar's entry. */
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
