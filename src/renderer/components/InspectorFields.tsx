import { useEffect, useState } from "react";
import { Flag, SlidersHorizontal } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { ulid } from "ulid";
import type { CanvasDoc, CanvasNode, EdgeCriteria, EtherEdgeKind, EtherFlag, EtherView, EtherWatch } from "@shared/canvas";
import { towerProjectKey } from "@shared/execution-graph";
import { findEntity } from "@shared/entities";
import { addEdge, setEdgeCriteria } from "../lib/edge-mutations";
import { commitDoc, editFileDetails, editGroupBackground, editLink, editText, renameGroup, setNodeTasks, setNodeTimer, setNodeView, setNodeWatch, setRegionHold, toggleFlag } from "../lib/mutations";
import { glyphStateHue, orbitOptions, TOWER_STATES } from "../lib/browse";
import { state$ } from "../lib/state";
import { armRegion, kernel$, pulseRegion } from "../lib/kernel-view";
import { HUE, withAlpha } from "../lib/theme";
import { nodeTitle, searchText } from "../lib/presentation";

const FLAG_OPTIONS: ReadonlyArray<{ readonly flag: EtherFlag; readonly hue: string }> = [
  { flag: "blocker", hue: HUE.crimson },
  { flag: "attention", hue: HUE.amber },
  { flag: "parked", hue: HUE.violet },
];

export function NodeFieldEditors({ node }: { readonly node: CanvasNode }) {
  const textValue = node.type === "text" ? node.text : "";
  const linkValue = node.type === "link" ? node.url : "";
  const groupLabelValue = node.type === "group" ? node.label ?? "" : "";
  const fileValue = node.type === "file" ? node.file : "";
  const subpathValue = node.type === "file" ? node.subpath ?? "" : "";
  const backgroundValue = node.type === "group" ? node.background ?? "" : "";
  const backgroundStyleValue = node.type === "group" ? node.backgroundStyle ?? "cover" : "cover";
  const [textDraft, setTextDraft] = useState(textValue);
  const [linkDraft, setLinkDraft] = useState(linkValue);
  const [groupLabelDraft, setGroupLabelDraft] = useState(groupLabelValue);
  const [fileDraft, setFileDraft] = useState(fileValue);
  const [subpathDraft, setSubpathDraft] = useState(subpathValue);
  const [backgroundDraft, setBackgroundDraft] = useState(backgroundValue);
  const [backgroundStyleDraft, setBackgroundStyleDraft] = useState<"cover" | "ratio" | "repeat">(backgroundStyleValue);

  useEffect(() => {
    setTextDraft(textValue);
    setLinkDraft(linkValue);
    setGroupLabelDraft(groupLabelValue);
    setFileDraft(fileValue);
    setSubpathDraft(subpathValue);
    setBackgroundDraft(backgroundValue);
    setBackgroundStyleDraft(backgroundStyleValue);
  }, [backgroundStyleValue, backgroundValue, fileValue, groupLabelValue, linkValue, node.id, subpathValue, textValue]);

  const commitText = () => { if (node.type === "text" && textDraft !== textValue) editText(node.id, textDraft); };
  const commitLink = () => { if (node.type === "link" && linkDraft.trim() && linkDraft.trim() !== linkValue) editLink(node.id, linkDraft.trim()); };
  const commitGroupLabel = () => { if (node.type === "group" && groupLabelDraft !== groupLabelValue) renameGroup(node.id, groupLabelDraft.trim()); };
  const commitFile = () => { if (node.type === "file") editFileDetails(node.id, fileDraft, subpathDraft); };
  const commitBackground = (background = backgroundDraft, style = backgroundStyleDraft) => { if (node.type === "group") editGroupBackground(node.id, background, style); };

  return <>
    {node.type === "text" ? <label className="inspector-editor"><span>{node.ether?.entity ? "label" : "note text"}</span><textarea aria-label={node.ether?.entity ? "Node label" : "Note text"} value={textDraft} onChange={(event) => setTextDraft(event.target.value)} onBlur={commitText} onKeyDown={(event) => { if (event.key === "Escape") { setTextDraft(textValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "link" ? <label className="inspector-editor"><span>web reference</span><input aria-label="Link URL" value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} onBlur={commitLink} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitLink(); event.currentTarget.blur(); } if (event.key === "Escape") { setLinkDraft(linkValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "group" ? <label className="inspector-editor"><span>region label</span><input aria-label="Region label" value={groupLabelDraft} placeholder="unnamed region" onChange={(event) => setGroupLabelDraft(event.target.value)} onBlur={commitGroupLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitGroupLabel(); event.currentTarget.blur(); } if (event.key === "Escape") { setGroupLabelDraft(groupLabelValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "file" ? <div className="inspector-section"><div className="inspector-section__label">file reference</div><div className="inspector-file-fields"><label><span>path</span><input aria-label="File path" value={fileDraft} onChange={(event) => setFileDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setFileDraft(fileValue); event.currentTarget.blur(); } }} /></label><label><span>subpath</span><input aria-label="File subpath" value={subpathDraft} placeholder="#section or block" onChange={(event) => setSubpathDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setSubpathDraft(subpathValue); event.currentTarget.blur(); } }} /></label></div></div> : null}
    {node.type === "group" ? <div className="inspector-section"><div className="inspector-section__label">background</div><div className="inspector-background"><input aria-label="Region background source" value={backgroundDraft} placeholder="image URL or file path" onChange={(event) => setBackgroundDraft(event.target.value)} onBlur={() => commitBackground()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitBackground(); event.currentTarget.blur(); } if (event.key === "Escape") { setBackgroundDraft(backgroundValue); event.currentTarget.blur(); } }} /><label><span>fit</span><select aria-label="Region background fit" value={backgroundStyleDraft} onChange={(event) => { const style = event.target.value as "cover" | "ratio" | "repeat"; setBackgroundStyleDraft(style); commitBackground(backgroundDraft, style); }}><option value="cover">cover</option><option value="ratio">contain</option><option value="repeat">repeat</option></select></label></div></div> : null}
    {node.type === "group" ? <RegionHoldControl node={node} /> : null}
    <KernelFieldEditors node={node} />
    {node.ether?.entity?.kind === "project" ? <ViewSliceFields node={node} /> : null}
  </>;
}

// Watcher/timer/region-pulse editors, grouped behind one call so the
// switchboard above reads as one branch per concern instead of three more
// node-type ternaries stacked onto an already-dense dispatcher.
function KernelFieldEditors({ node }: { readonly node: CanvasNode }) {
  return <>
    {node.type === "group" ? <RegionPulseControl node={node} /> : null}
    {node.ether?.entity?.kind === "watcher" ? <WatcherEditor node={node} /> : null}
    {node.ether?.entity?.kind === "timer" ? <TimerEditor node={node} /> : null}
    {node.ether?.entity?.kind === "task" ? <TasksEditor node={node} /> : null}
  </>;
}

function TasksEditor({ node }: { readonly node: CanvasNode }) {
  const items = node.ether?.tasks?.items ?? [];
  const commit = (next: typeof items) => setNodeTasks(node.id, next);
  return (
    <div className="inspector-section">
      <div className="inspector-section__label">checklist</div>
      <div className="flex flex-col gap-1.5">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-1.5">
            <button
              type="button"
              aria-label={item.done ? "Mark incomplete" : "Mark done"}
              className="inspector-flag-toggle"
              onClick={() =>
                commit(items.map((row) => (row.id === item.id ? { ...row, done: !row.done } : row)))
              }
            >
              {item.done ? "☑" : "☐"}
            </button>
            <input
              aria-label="Task text"
              className="flex-1"
              value={item.text}
              onChange={(event) =>
                commit(items.map((row) => (row.id === item.id ? { ...row, text: event.target.value } : row)))
              }
            />
            <button
              type="button"
              aria-label="Remove task"
              className="inspector-action--danger"
              onClick={() => commit(items.filter((row) => row.id !== item.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mt-2"
        onClick={() => commit([...items, { id: `item-${ulid()}`, text: "new item" }])}
      >
        add item
      </button>
      <div className="inspector-detail mt-1">
        Incomplete tasks block only when this node is the source of an edge with tasks criteria.
      </div>
    </div>
  );
}

export function EdgeCriteriaEditor({
  edgeId,
  fromNode,
}: {
  readonly edgeId: string;
  readonly fromNode: CanvasNode | undefined;
}) {
  const doc = use$(state$.doc);
  const edge = doc.edges.find((candidate) => candidate.id === edgeId);
  const criteria = edge?.ether?.criteria;
  const fromIsTask = fromNode?.ether?.entity?.kind === "task";
  const towerKey = towerProjectKey(fromNode) ?? "";

  const mode: "none" | "glyphs" | "wip" | "tasks" = !criteria
    ? "none"
    : criteria.mode;

  const setMode = (next: "none" | "glyphs" | "wip" | "tasks") => {
    if (next === "none") {
      setEdgeCriteria(edgeId, undefined);
      return;
    }
    if (next === "wip") {
      setEdgeCriteria(edgeId, {
        mode: "wip",
        ...(towerKey ? { project: towerKey } : {}),
      });
      return;
    }
    if (next === "tasks") {
      setEdgeCriteria(edgeId, { mode: "tasks" });
      return;
    }
    const existing = criteria?.mode === "glyphs" ? criteria.glyphIds : [];
    setEdgeCriteria(edgeId, {
      mode: "glyphs",
      glyphIds: existing.length > 0 ? [...existing] : [],
      ...(towerKey ? { project: towerKey } : {}),
    });
  };

  const glyphIdsText =
    criteria?.mode === "glyphs" ? criteria.glyphIds.join(", ") : "";

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">live criteria</div>
      <label className="inspector-editor">
        <span>binding</span>
        <select
          aria-label="Edge criteria mode"
          value={mode}
          onChange={(event) => setMode(event.target.value as "none" | "glyphs" | "wip" | "tasks")}
        >
          <option value="none">none · plain relates (or legacy pin)</option>
          <option value="glyphs">selected glyphs must be done</option>
          <option value="wip">opt-in WIP (committed|building|reviewing)</option>
          {fromIsTask ? <option value="tasks">tasks checklist on source</option> : null}
        </select>
      </label>
      {mode === "glyphs" ? (
        <label className="inspector-editor">
          <span>glyph ids</span>
          <input
            aria-label="Glyph ids for edge criteria"
            placeholder="comma-separated glyph ids"
            defaultValue={glyphIdsText}
            key={`${edgeId}:${glyphIdsText}`}
            onBlur={(event) => {
              const glyphIds = event.target.value
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean);
              const next: EdgeCriteria = {
                mode: "glyphs",
                glyphIds,
                ...(towerKey ? { project: towerKey } : {}),
                ...(criteria?.mode === "glyphs" && criteria.orbit ? { orbit: criteria.orbit } : {}),
              };
              setEdgeCriteria(edgeId, next);
            }}
          />
        </label>
      ) : null}
      {mode === "wip" ? (
        <div className="inspector-detail">
          Blocks while any glyph on the source project is in committed, building, or reviewing.
          Opt-in only — never the default for projects.
        </div>
      ) : null}
      {mode === "tasks" ? (
        <div className="inspector-detail">
          Blocks while incomplete items remain on the source tasks node.
        </div>
      ) : null}
      {mode === "none" ? (
        <div className="inspector-detail">
          No live binding. Use cycle kind for a static pin, or attach glyphs/WIP/tasks above.
        </div>
      ) : null}
    </div>
  );
}

// Region hold (group nodes only): a structural container whose contents
// travel with it when dragged. Membership is derived from geometry at drag
// time — this toggle only ever writes the boolean flag, never a member list.
function RegionHoldControl({ node }: { readonly node: CanvasNode }) {
  const hold = Boolean(node.ether?.region?.hold);
  return <div className="inspector-section">
    <div className="inspector-section__label">region</div>
    <div className="inspector-flags">
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-label="Hold contents"
        aria-pressed={hold}
        style={{ color: hold ? HUE.amber : "#68604a", borderColor: hold ? withAlpha(HUE.amber, 0.5) : "rgba(237,230,218,.12)", background: hold ? withAlpha(HUE.amber, 0.1) : "rgba(255,255,255,.02)" }}
        onClick={() => setRegionHold(node.id, !hold)}
      >hold contents</button>
    </div>
  </div>;
}

const withoutKey = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

// The region's pulse briefing text is document data (unlike ARM, which is
// app-state only — see canvas.ts). This writes ether.region.instruction
// directly via commitDoc rather than a lib/mutations.ts export: the watcher
// and timer mutations are this lane's only grant into that file, so the
// third document write this section needs stays local, following the same
// strip pattern as setRegionHold.
const commitRegionInstruction = (node: CanvasNode, instruction: string): void => {
  const trimmed = instruction.trim();
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== node.id) return n;
      if (trimmed) {
        return { ...n, ether: { ...(n.ether ?? {}), region: { ...(n.ether?.region ?? {}), instruction: trimmed } } };
      }
      if (!n.ether?.region) return n;
      const nextRegion = withoutKey(n.ether.region, "instruction");
      const nextEther = Object.keys(nextRegion).length ? { ...n.ether, region: nextRegion } : withoutKey(n.ether, "region");
      return (Object.keys(nextEther).length ? { ...n, ether: nextEther } : withoutKey(n, "ether")) as CanvasNode;
    }),
  });
};

// Region pulse surface: the briefing every agent inside receives, the ARM
// switch (app-state only — armRegion never touches the document), and manual
// pulse/dry-pulse triggers. Arming is deliberately never silent: the caution
// line says exactly what flipping it costs.
function RegionPulseControl({ node }: { readonly node: CanvasNode }) {
  const instructionValue = node.ether?.region?.instruction ?? "";
  const [instructionDraft, setInstructionDraft] = useState(instructionValue);
  const armed = Boolean(use$(kernel$.armed[node.id]));
  const [pulseError, setPulseError] = useState("");
  const [armError, setArmError] = useState("");

  useEffect(() => { setInstructionDraft(instructionValue); setArmError(""); }, [node.id, instructionValue]);

  const commitInstruction = () => {
    if (instructionDraft === instructionValue) return;
    commitRegionInstruction(node, instructionDraft);
  };

  // Arming is transactional in main (store write before the memory flip); a
  // failed persist returns { ok:false } instead of throwing, so the toggle
  // never lies about a change that did not stick. Surface it quietly inline.
  const toggleArm = () => {
    setArmError("");
    void armRegion(node.id, !armed)
      .then((result) => { if (!result.ok) setArmError(result.error ?? "arming did not save"); })
      .catch((error: unknown) => setArmError(error instanceof Error ? error.message : String(error)));
  };

  const runPulse = (dry: boolean) => {
    setPulseError("");
    void pulseRegion(node.id, { dry }).catch((error: unknown) => setPulseError(error instanceof Error ? error.message : String(error)));
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">pulse briefing</div>
    <label className="inspector-editor">
      <span>every agent inside receives this</span>
      <textarea
        aria-label="Region pulse briefing"
        placeholder="what should agents inside this region do when it pulses?"
        value={instructionDraft}
        onChange={(event) => setInstructionDraft(event.target.value)}
        onBlur={commitInstruction}
        onKeyDown={(event) => { if (event.key === "Escape") { setInstructionDraft(instructionValue); event.currentTarget.blur(); } }}
      />
    </label>
    <div className="inspector-flags mt-2">
      <button
        type="button"
        className="inspector-flag-toggle"
        aria-label="Arm region"
        aria-pressed={armed}
        style={{ color: armed ? HUE.amber : "#68604a", borderColor: armed ? withAlpha(HUE.amber, 0.5) : "rgba(237,230,218,.12)", background: armed ? withAlpha(HUE.amber, 0.1) : "rgba(255,255,255,.02)" }}
        onClick={toggleArm}
      >{armed ? "armed" : "disarmed"}</button>
    </div>
    {armError
      ? <button type="button" aria-label="Dismiss arming error" title="dismiss" onClick={() => setArmError("")} className="mt-1 block w-full cursor-pointer text-left text-[9px] uppercase tracking-[0.14em]" style={{ color: withAlpha(HUE.crimson, 0.85) }}>{armError}</button>
      : <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.6) }}>armed pulses spend real agent turns</div>}
    <div className="mt-2 flex gap-2">
      <button type="button" className="inspector-flag-toggle" onClick={() => runPulse(false)}>pulse now</button>
      <button type="button" className="inspector-flag-toggle" onClick={() => runPulse(true)}>dry pulse</button>
    </div>
    {pulseError ? <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.8) }}>{pulseError}</div> : null}
  </div>;
}

const WATCH_KIND_OPTIONS: ReadonlyArray<{ readonly value: EtherWatch["kind"]; readonly label: string }> = [
  { value: "glyphs_done", label: "all glyphs done" },
  { value: "glyphs_entered_state", label: "on glyphs entering state" },
  { value: "stat_threshold", label: "stat threshold" },
];

const STAT_SOURCE_OPTIONS: ReadonlyArray<NonNullable<EtherWatch["source"]>> = ["tower", "quasar", "booth", "hermes"];

const STAT_OP_OPTIONS: ReadonlyArray<{ readonly value: NonNullable<EtherWatch["op"]>; readonly label: string }> = [
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "eq", label: "equal to" },
];

// Enter commits and blurs; every text field below shares this handler.
const commitOnEnter = (onCommit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  onCommit();
  event.currentTarget.blur();
};

// The glyph-rule scope (glyphs_done, glyphs_entered_state): project + orbit
// + an explicit glyphIds allowlist. Empty glyphIds means every glyph in scope.
function GlyphScopeFields({ project, orbit, glyphIdsText, towerKey, onProject, onOrbit, onGlyphIds, onCommit }: {
  readonly project: string;
  readonly orbit: string;
  readonly glyphIdsText: string;
  readonly towerKey: string | undefined;
  readonly onProject: (value: string) => void;
  readonly onOrbit: (value: string) => void;
  readonly onGlyphIds: (value: string) => void;
  readonly onCommit: () => void;
}) {
  const onEnter = commitOnEnter(onCommit);
  return <>
    <label className="inspector-editor">
      <span>project</span>
      <input aria-label="Watcher project" value={project} placeholder={towerKey ?? "project key"} onChange={(event) => onProject(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>orbit</span>
      <input aria-label="Watcher orbit" value={orbit} placeholder="all orbits" onChange={(event) => onOrbit(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>glyph ids</span>
      <input aria-label="Watcher glyph ids" value={glyphIdsText} placeholder="comma-separated · empty = every glyph in scope" onChange={(event) => onGlyphIds(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
  </>;
}

// The stat_threshold rule: a numeric comparison on a bound entity's stat.
// Selects commit immediately (onSourceChange/onOpChange carry the override
// into the same commit call — React state from setSource/setOp wouldn't be
// flushed yet if commit() read it directly); text fields commit on blur.
function StatThresholdFields({ source, entityKey, stat, op, valueText, onSourceChange, onKey, onStat, onOpChange, onValue, onCommit }: {
  readonly source: NonNullable<EtherWatch["source"]>;
  readonly entityKey: string;
  readonly stat: string;
  readonly op: NonNullable<EtherWatch["op"]>;
  readonly valueText: string;
  readonly onSourceChange: (value: NonNullable<EtherWatch["source"]>) => void;
  readonly onKey: (value: string) => void;
  readonly onStat: (value: string) => void;
  readonly onOpChange: (value: NonNullable<EtherWatch["op"]>) => void;
  readonly onValue: (value: string) => void;
  readonly onCommit: () => void;
}) {
  const onEnter = commitOnEnter(onCommit);
  return <>
    <label className="inspector-editor">
      <span>source</span>
      <select aria-label="Watcher stat source" value={source} onChange={(event) => onSourceChange(event.target.value as NonNullable<EtherWatch["source"]>)}>
        {STAT_SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </label>
    <label className="inspector-editor">
      <span>key</span>
      <input aria-label="Watcher entity key" value={entityKey} placeholder="bound entity key" onChange={(event) => onKey(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>stat</span>
      <input aria-label="Watcher stat name" value={stat} placeholder="e.g. glyphs_active" onChange={(event) => onStat(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
    <label className="inspector-editor">
      <span>op</span>
      <select aria-label="Watcher comparison" value={op} onChange={(event) => onOpChange(event.target.value as NonNullable<EtherWatch["op"]>)}>
        {STAT_OP_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
    <label className="inspector-editor">
      <span>value</span>
      <input aria-label="Watcher threshold value" type="number" value={valueText} onChange={(event) => onValue(event.target.value)} onBlur={onCommit} onKeyDown={onEnter} />
    </label>
  </>;
}

// Every watch field's draft state, reset together whenever the inspected
// node changes — split out of WatcherEditor so the component body reads as
// "options + commit", not a wall of useState declarations.
function useWatchDraft(nodeId: string, watch: EtherWatch | undefined, towerKey: string | undefined) {
  const [kind, setKind] = useState<EtherWatch["kind"]>(watch?.kind ?? "glyphs_done");
  const [project, setProject] = useState(watch?.project ?? towerKey ?? "");
  const [orbit, setOrbit] = useState(watch?.orbit ?? "");
  const [glyphIdsText, setGlyphIdsText] = useState((watch?.glyphIds ?? []).join(", "));
  const [stateName, setStateName] = useState(watch?.state ?? "committed");
  const [source, setSource] = useState<NonNullable<EtherWatch["source"]>>(watch?.source ?? "tower");
  const [key, setKey] = useState(watch?.key ?? "");
  const [stat, setStat] = useState(watch?.stat ?? "");
  const [op, setOp] = useState<NonNullable<EtherWatch["op"]>>(watch?.op ?? "gt");
  const [valueText, setValueText] = useState(watch?.value !== undefined ? String(watch.value) : "");
  const [flagOnUnsatisfied, setFlagOnUnsatisfied] = useState(Boolean(watch?.flagOnUnsatisfied));

  useEffect(() => {
    setKind(watch?.kind ?? "glyphs_done");
    setProject(watch?.project ?? towerKey ?? "");
    setOrbit(watch?.orbit ?? "");
    setGlyphIdsText((watch?.glyphIds ?? []).join(", "));
    setStateName(watch?.state ?? "committed");
    setSource(watch?.source ?? "tower");
    setKey(watch?.key ?? "");
    setStat(watch?.stat ?? "");
    setOp(watch?.op ?? "gt");
    setValueText(watch?.value !== undefined ? String(watch.value) : "");
    setFlagOnUnsatisfied(Boolean(watch?.flagOnUnsatisfied));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset drafts only on node identity change, not on every keystroke into watch/*
  }, [nodeId]);

  return {
    kind, setKind, project, setProject, orbit, setOrbit, glyphIdsText, setGlyphIdsText,
    stateName, setStateName, source, setSource, key, setKey, stat, setStat, op, setOp,
    valueText, setValueText, flagOnUnsatisfied, setFlagOnUnsatisfied,
  };
}

// Watcher editor: kind picks which shape of predicate this node evaluates;
// fields below narrow by kind. flagOnUnsatisfied only applies to the level
// rules (glyphs_done, stat_threshold) — glyphs_entered_state is an edge rule
// with no persistent "unsatisfied" state to mirror (see canvas.ts).
function WatcherEditor({ node }: { readonly node: CanvasNode }) {
  const watch = node.ether?.watch;
  const towerKey = towerProjectKey(node);
  const {
    kind, setKind, project, setProject, orbit, setOrbit, glyphIdsText, setGlyphIdsText,
    stateName, setStateName, source, setSource, key, setKey, stat, setStat, op, setOp,
    valueText, setValueText, flagOnUnsatisfied, setFlagOnUnsatisfied,
  } = useWatchDraft(node.id, watch, towerKey);

  type Overrides = Partial<{
    readonly kind: EtherWatch["kind"];
    readonly state: string;
    readonly source: NonNullable<EtherWatch["source"]>;
    readonly op: NonNullable<EtherWatch["op"]>;
    readonly flagOnUnsatisfied: boolean;
  }>;

  const commit = (overrides: Overrides = {}) => {
    const nextKind = overrides.kind ?? kind;
    const nextState = overrides.state ?? stateName;
    const nextSource = overrides.source ?? source;
    const nextOp = overrides.op ?? op;
    const nextFlag = overrides.flagOnUnsatisfied ?? flagOnUnsatisfied;
    const parsedValue = valueText.trim() === "" ? undefined : Number(valueText);
    const nextWatch: EtherWatch = {
      kind: nextKind,
      ...(project.trim() ? { project: project.trim() } : {}),
      ...(orbit.trim() ? { orbit: orbit.trim() } : {}),
      ...(glyphIdsText.trim() ? { glyphIds: glyphIdsText.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(nextKind === "glyphs_entered_state" ? { state: nextState.trim() || "committed" } : {}),
      ...(nextKind === "stat_threshold" ? {
        source: nextSource,
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(stat.trim() ? { stat: stat.trim() } : {}),
        op: nextOp,
        ...(parsedValue !== undefined && Number.isFinite(parsedValue) ? { value: parsedValue } : {}),
      } : {}),
      ...(nextKind !== "glyphs_entered_state" ? { flagOnUnsatisfied: nextFlag } : {}),
    };
    setNodeWatch(node.id, nextWatch);
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">watcher</div>
    <label className="inspector-editor">
      <span>kind</span>
      <select aria-label="Watcher kind" value={kind} onChange={(event) => { const next = event.target.value as EtherWatch["kind"]; setKind(next); commit({ kind: next }); }}>
        {WATCH_KIND_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
    {kind !== "stat_threshold" ? (
      <GlyphScopeFields
        project={project}
        orbit={orbit}
        glyphIdsText={glyphIdsText}
        towerKey={towerKey}
        onProject={setProject}
        onOrbit={setOrbit}
        onGlyphIds={setGlyphIdsText}
        onCommit={() => commit()}
      />
    ) : null}
    {kind === "glyphs_entered_state" ? (
      <label className="inspector-editor">
        <span>entered state</span>
        <select aria-label="Watcher target state" value={stateName} onChange={(event) => { setStateName(event.target.value); commit({ state: event.target.value }); }}>
          {TOWER_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    ) : null}
    {kind === "stat_threshold" ? (
      <StatThresholdFields
        source={source}
        entityKey={key}
        stat={stat}
        op={op}
        valueText={valueText}
        onSourceChange={(next) => { setSource(next); commit({ source: next }); }}
        onKey={setKey}
        onStat={setStat}
        onOpChange={(next) => { setOp(next); commit({ op: next }); }}
        onValue={setValueText}
        onCommit={() => commit()}
      />
    ) : null}
    {kind !== "glyphs_entered_state" ? (
      <div className="inspector-flags mt-2">
        <button
          type="button"
          className="inspector-flag-toggle"
          aria-label="Flag when unsatisfied"
          aria-pressed={flagOnUnsatisfied}
          style={{ color: flagOnUnsatisfied ? HUE.crimson : "#68604a", borderColor: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.5) : "rgba(237,230,218,.12)", background: flagOnUnsatisfied ? withAlpha(HUE.crimson, 0.1) : "rgba(255,255,255,.02)" }}
          onClick={() => { const next = !flagOnUnsatisfied; setFlagOnUnsatisfied(next); commit({ flagOnUnsatisfied: next }); }}
        >flag when unsatisfied</button>
      </div>
    ) : null}
  </div>;
}

const MIN_TIMER_EVERY_MINUTES = 5;

// Timer editor: one field, one v1 guard — the 5-minute floor is enforced
// here before the value ever reaches setNodeTimer.
function TimerEditor({ node }: { readonly node: CanvasNode }) {
  const timer = node.ether?.timer;
  const defaultMinutes = timer?.everyMinutes ?? 30;
  const [minutesText, setMinutesText] = useState(String(defaultMinutes));
  const [error, setError] = useState("");

  useEffect(() => {
    setMinutesText(String(timer?.everyMinutes ?? 30));
    setError("");
  }, [node.id, timer?.everyMinutes]);

  const commit = () => {
    const parsed = Number(minutesText);
    if (!Number.isFinite(parsed) || parsed < MIN_TIMER_EVERY_MINUTES) {
      setError(`minimum is ${MIN_TIMER_EVERY_MINUTES}m`);
      return;
    }
    setError("");
    setNodeTimer(node.id, { everyMinutes: Math.round(parsed) });
  };

  return <div className="inspector-section">
    <div className="inspector-section__label">timer</div>
    <label className="inspector-editor">
      <span>every (minutes)</span>
      <input
        aria-label="Timer interval minutes"
        type="number"
        min={MIN_TIMER_EVERY_MINUTES}
        value={minutesText}
        onChange={(event) => setMinutesText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setMinutesText(String(timer?.everyMinutes ?? 30)); setError(""); event.currentTarget.blur(); }
        }}
      />
    </label>
    {error ? <div className="mt-1 text-[9px]" style={{ color: withAlpha(HUE.crimson, 0.8) }}>{error}</div> : null}
  </div>;
}

// A project node's view slice: an optional lens (orbit, glyph filter, state
// set) over the SAME bound project — several nodes can bind one project with
// different slices ("prism · forge" here, "prism · beacon" there). Purely
// presentational; setNodeView never touches the binding itself.
export function ViewSliceFields({ node }: { readonly node: CanvasNode }) {
  const snapshots = use$(state$.snapshots);
  const towerKey = towerProjectKey(node);
  const towerEntity = towerKey ? findEntity(snapshots, "tower", towerKey) : undefined;
  const orbits = orbitOptions(towerEntity?.stats);
  const view = node.ether?.view;
  const orbitValue = view?.orbit ?? "";
  const queryValue = view?.glyphQuery ?? "";
  const statesValue = view?.states ?? [];
  const [orbitDraft, setOrbitDraft] = useState(orbitValue);
  const [queryDraft, setQueryDraft] = useState(queryValue);

  useEffect(() => {
    setOrbitDraft(orbitValue);
    setQueryDraft(queryValue);
  }, [node.id, orbitValue, queryValue]);

  const commit = (overrides: { readonly orbit?: string; readonly glyphQuery?: string; readonly states?: ReadonlyArray<string> }): void => {
    const nextView: EtherView = {
      orbit: overrides.orbit ?? orbitDraft,
      glyphQuery: overrides.glyphQuery ?? queryDraft,
      states: overrides.states ?? statesValue,
    };
    setNodeView(node.id, nextView);
  };

  const toggleState = (stateName: string) => {
    const next = statesValue.includes(stateName) ? statesValue.filter((s) => s !== stateName) : [...statesValue, stateName];
    commit({ states: next });
  };

  return <div className="inspector-section">
    <div className="inspector-section__label"><SlidersHorizontal size={11} /> view slice</div>
    <label className="inspector-editor">
      <span>orbit</span>
      <select aria-label="View slice orbit" value={orbitDraft} onChange={(event) => { setOrbitDraft(event.target.value); commit({ orbit: event.target.value }); }}>
        <option value="">all orbits</option>
        {orbits.map((orbit) => <option key={orbit} value={orbit}>{orbit}</option>)}
      </select>
    </label>
    <label className="inspector-editor">
      <span>glyph filter</span>
      <input
        aria-label="View slice glyph filter"
        value={queryDraft}
        placeholder="substring or /regex/"
        onChange={(event) => setQueryDraft(event.target.value)}
        onBlur={() => commit({ glyphQuery: queryDraft })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); commit({ glyphQuery: queryDraft }); event.currentTarget.blur(); }
          if (event.key === "Escape") { setQueryDraft(queryValue); event.currentTarget.blur(); }
        }}
      />
    </label>
    <div className="inspector-flags">
      {TOWER_STATES.map((stateName) => {
        const active = statesValue.includes(stateName);
        const hue = glyphStateHue(stateName);
        return <button key={stateName} type="button" className="inspector-flag-toggle" aria-pressed={active} style={{ color: active ? hue : "#68604a", borderColor: active ? withAlpha(hue, 0.5) : "rgba(237,230,218,.12)", background: active ? withAlpha(hue, 0.1) : "rgba(255,255,255,.02)" }} onClick={() => toggleState(stateName)}>{stateName}</button>;
      })}
    </div>
  </div>;
}

export function NodeFlagControls({ node }: { readonly node: CanvasNode }) {
  const flags = node.ether?.flags ?? [];
  return <div className="inspector-section"><div className="inspector-section__label"><Flag size={11} /> flags</div><div className="inspector-flags">{FLAG_OPTIONS.map(({ flag, hue }) => { const active = flags.includes(flag); return <button key={flag} type="button" className="inspector-flag-toggle" aria-pressed={active} style={{ color: active ? hue : "#68604a", borderColor: active ? withAlpha(hue, 0.5) : "rgba(237,230,218,.12)", background: active ? withAlpha(hue, 0.1) : "rgba(255,255,255,.02)" }} onClick={() => toggleFlag(node.id, flag)}>{flag}</button>; })}</div></div>;
}

export function ConnectEditor({ node, doc, open, onOpenChange }: { readonly node: CanvasNode; readonly doc: CanvasDoc; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [targetId, setTargetId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [edgeKind, setEdgeKind] = useState<EtherEdgeKind>("relates");
  const targets = doc.nodes.filter((candidate) => candidate.id !== node.id && candidate.type !== "group");
  const availableTargets = targets.filter((target) => !doc.edges.some((edge) => edge.fromNode === node.id && edge.toNode === target.id));
  const filteredTargets = availableTargets.filter((target) => !targetQuery.trim() || searchText(target).includes(targetQuery.trim().toLowerCase()));
  const connect = () => {
    if (!targetId) return;
    addEdge({ source: node.id, target: targetId, kind: edgeKind });
    setTargetId("");
    setTargetQuery("");
    setEdgeKind("relates");
    onOpenChange(false);
  };
  if (!open) return null;
  return <div className="inspector-connect"><label><span>find a node <em>{filteredTargets.length}/{availableTargets.length}</em></span><input aria-label="Find a node" value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder="name, source, or binding" /></label>{availableTargets.length === 0 ? <div className="inspector-connect__empty">No unlinked nodes available.</div> : filteredTargets.length === 0 ? <div className="inspector-connect__empty">No nodes match this filter.</div> : <label><span>connect to</span><select aria-label="Connect to node" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">choose a node</option>{filteredTargets.map((target) => <option key={target.id} value={target.id}>{nodeTitle(target)} · {target.type}</option>)}</select></label>}<label><span>edge kind</span><select aria-label="Edge kind" value={edgeKind} onChange={(event) => setEdgeKind(event.target.value as EtherEdgeKind)}><option value="relates">relates</option><option value="depends">depends</option><option value="blocks">blocks</option></select></label><button disabled={!targetId} onClick={connect}>create edge</button></div>;
}
