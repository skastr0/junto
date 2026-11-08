import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { useRtsNodes } from "../lib/rts-selection";
import { HashMap, HashSet, Option } from "effect";
import type { RegionDefaults } from "@shared/model/region";
import {
  BROWSER_ENABLED,
  TASKS_ENABLED,
} from "@shared/features";
import {
  asNodeId,
  type FactoryRoleName,
} from "@shared/physics";
import { canvasToCapabilityView } from "@shared/physics/view";
import { releaseFocus } from "../lib/focus-ownership";
import { regionEdited } from "../lib/model-edits";
import { commitCommands, editLink, editText, setFilesRoot, setGitCwd, setPageBinding, setRegionDefaults } from "../lib/mutations";
import { isAbsoluteFolder } from "../lib/model-factories";
import { AgentMessagesPane } from "./work/WorkSurfaces";
import { state$ } from "../lib/state";
import { isOnMachine, machineLabelIn, useMachines, useThisMachineName } from "../lib/machines";
import { physicsKind, roleOfKind } from "../lib/model-kind";
import { useCanvas, useNode, useNodeOf, useNodeValue } from "../lib/use-model";
import { asNodeId as asModelNodeId } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { Chip } from "./ui";
import { RegionRules } from "./rules";
import { BrowserProfileSelect } from "./HostPickers";
import { BriefingDocument } from "./briefing/BriefingDocument";

// ---------------------------------------------------------------------------
// Canvas physics — capability inventory (read-only) + "limit this key" editor

type CapabilityNeighbor = {
  readonly id: string;
  readonly title: string;
  readonly role: FactoryRoleName;
  readonly kind: string | undefined;
};

/** Actor: "reaches"; sink: "reached by" — plain inventory, no physics lecture. */
export function NodeCapabilityInventory({ nodeId }: { readonly nodeId: string }) {
  // Who a node reaches depends on every wire and every region, so the canvas
  // is followed whole; this is mounted only while a node is inspected.
  const canvas = useCanvas(use$(state$.canvasName));
  // The window edits the canvas it has open, so a node that names no machine is on this one.
  const editingMachine = useThisMachineName();

  const inventory = useMemo(() => {
    const self = canvas.nodes.get(asModelNodeId(nodeId));
    if (!self) return null;
    const selfRole = roleOfKind(self.kind);
    if (selfRole !== "actor" && selfRole !== "sink") return null;
    const view = canvasToCapabilityView(canvas, { editingMachine });
    const neighbors = HashMap.get(view.connected, asNodeId(nodeId));
    if (Option.isNone(neighbors) || HashSet.size(neighbors.value) === 0) {
      return { role: selfRole, rows: [] as CapabilityNeighbor[] };
    }
    const rows: CapabilityNeighbor[] = [];
    for (const peerId of neighbors.value) {
      const peer = canvas.nodes.get(asModelNodeId(peerId));
      if (!peer) continue;
      const peerRole = roleOfKind(peer.kind);
      // Actor: everything it reaches; sink: inbound callers only.
      if (selfRole === "sink" && peerRole !== "actor") continue;
      rows.push({
        id: peerId,
        title: titleOf(peer),
        role: peerRole,
        kind: physicsKind(peer.kind),
      });
    }
    rows.sort((a, b) => a.title.localeCompare(b.title));
    return { role: selfRole, rows };
  }, [canvas, nodeId, editingMachine]);

  if (!inventory) return null;

  const label = inventory.role === "actor" ? "connected to" : "used by";

  if (inventory.rows.length === 0) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">{label}</div>
      <div className="inspector-bindings mt-2">
        {inventory.rows.map((row) => (
          <div key={row.id} className="inspector-binding" title={row.title}>
            <span className="inspector-binding__source">
              {row.kind ?? row.role}
            </span>
            <span className="min-w-0 flex-1 truncate">{row.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The machine a node runs on, as the operator named it, and nothing more. */
export function NodePlacementSection({ nodeId }: { readonly nodeId: string }) {
  // The machine a node runs on is the one field of it this reads.
  const host = useNodeValue(use$(state$.canvasName), nodeId, (held) =>
    held !== undefined && "host" in held ? held.host : undefined,
  );
  const thisMachine = useThisMachineName();
  const machines = useMachines();
  if (host === undefined) return null;
  const here = isOnMachine(host, thisMachine);

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">machine</div>
      <div className="inspector-flags" role="list" aria-label="Machine">
        <Chip tone={here ? "amber" : "cyan"} title={here ? "Runs on this machine" : "Runs on another machine"}>
          {machineLabelIn(machines, host)}
        </Chip>
      </div>
    </div>
  );
}

export function NodeFieldEditors({ nodeId }: { readonly nodeId: string }) {
  const node = useNode(use$(state$.canvasName), nodeId);
  const textValue = node && "text" in node ? node.text : node && "label" in node ? node.label ?? "" : "";
  const gitCwdValue = node?.kind === "git" ? node.cwd : "";
  const filesRootValue = node?.kind === "files" ? node.root : "";
  const [textDraft, setTextDraft] = useState(textValue);
  const [gitCwdDraft, setGitCwdDraft] = useState(gitCwdValue);
  const [filesRootDraft, setFilesRootDraft] = useState(filesRootValue);
  useEffect(() => {
    setTextDraft(textValue);
    setGitCwdDraft(gitCwdValue);
    setFilesRootDraft(filesRootValue);
  }, [filesRootValue, gitCwdValue, nodeId, textValue]);
  // A Files node holds an absolute folder; anything else goes back to the one it had.
  const commitFilesRoot = () => {
    if (isAbsoluteFolder(filesRootDraft)) setFilesRoot(nodeId, filesRootDraft);
    else setFilesRootDraft(filesRootValue);
  };

  const commitText = () => { if (node && ["note", "label", "agent", "terminal"].includes(node.kind) && textDraft !== textValue) editText(nodeId, textDraft); };

  return <>
    {/* Work sinks / schedulers rename via kind-strip pencil — no fat label field. */}
    {node && ["note", "label", "agent", "terminal"].includes(node.kind) ? (
      <label className="inspector-editor">
        <span>{node?.kind !== "note" ? "label" : "note text"}</span>
        <textarea
          data-focus-owner="canvas-draft"
          aria-label={node?.kind !== "note" ? "Node label" : "Note text"}
          value={textDraft}
          onChange={(event) => setTextDraft(event.target.value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setTextDraft(textValue);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    ) : null}
    {node?.kind === "git" ? (
      <label className="inspector-editor">
        <span>repository folder</span>
        <input
          data-focus-owner="canvas-draft"
          aria-label="Git repository folder"
          value={gitCwdDraft}
          onChange={(event) => setGitCwdDraft(event.target.value)}
          onBlur={() => setGitCwd(nodeId, gitCwdDraft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setGitCwd(nodeId, gitCwdDraft);
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setGitCwdDraft(gitCwdValue);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    ) : null}
    {node?.kind === "files" ? (
      <label className="inspector-editor">
        <span>folder</span>
        <input
          data-focus-owner="canvas-draft"
          aria-label="Files folder"
          value={filesRootDraft}
          onChange={(event) => setFilesRootDraft(event.target.value)}
          onBlur={commitFilesRoot}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitFilesRoot();
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setFilesRootDraft(filesRootValue);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    ) : null}
    {node?.kind === "agent"
      ? <div className="inspector-section">
          <div className="inspector-section__label">machine</div>
          <div className="inspector-detail">
            This agent lives on its machine. To run one elsewhere, add a new agent there.
          </div>
        </div>
      : null}
    <KernelFieldEditors nodeId={nodeId} />
  </>;
}


/** Browser profile for a page — used from RTS kind-strip pop. */
export function PageBindingControl({ nodeId }: { readonly nodeId: string }) {
  const node = useRtsNodes(use$(state$.canvasName), [nodeId])[0];
  const storedProfile = node?.kind === "page" ? node.profile : "personal";
  const [profile, setProfile] = useState(storedProfile);

  useEffect(() => {
    setProfile(storedProfile);
  }, [nodeId, storedProfile]);

  if (node?.kind !== "page") return null;
  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">browser binding</div>
      <label className="inspector-editor">
        <span>profile</span>
        <BrowserProfileSelect
          ariaLabel="Page browser profile"
          value={profile}
          onChange={(next) => {
            setProfile(next);
            setPageBinding(nodeId, { profile: next });
          }}
        />
      </label>
    </div>
  );
}

/** Page URL — used from RTS kind-strip pop. */
export function PageUrlControl({ nodeId }: { readonly nodeId: string }) {
  const node = useRtsNodes(use$(state$.canvasName), [nodeId])[0];
  const url = node?.kind === "page" ? node.url : "";
  const [draft, setDraft] = useState(url);
  useEffect(() => {
    setDraft(url);
  }, [nodeId, url]);
  const commit = () => {
    const next = draft.trim();
    if (!next || next === url || node?.kind !== "page") return;
    editLink(nodeId, next);
  };
  if (node?.kind !== "page") return null;
  return (
    <div className="inspector-section" style={{ marginTop: 0 }}>
      <div className="inspector-section__label">page url</div>
      <label className="inspector-editor">
        <span>url</span>
        <input
          data-focus-owner="canvas-draft"
          aria-label="Page URL"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
              releaseFocus(event.currentTarget, "gesture");
            }
            if (event.key === "Escape") {
              setDraft(url);
              releaseFocus(event.currentTarget, "gesture");
            }
          }}
        />
      </label>
    </div>
  );
}

// Per-kind panes below the fields. Regions never reach this form: their
// fields open from the region kind strip.
function KernelFieldEditors({ nodeId }: { readonly nodeId: string }) {
  const kind = useNodeValue(use$(state$.canvasName), nodeId, (node) => node?.kind);
  return kind === "agent" ? <AgentMessagesPane nodeId={nodeId} /> : null;
}

const commitOnEnter = (onCommit: () => void) => (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  onCommit();
  releaseFocus(event.currentTarget, "gesture");
};

/** Defaults for new page nodes created inside this region. */
export function RegionPageDefaultsControl({ nodeId: regionId }: { readonly nodeId: string }) {
  const stored = useNodeOf(use$(state$.canvasName), regionId, "region")?.defaults;
  const [pageUrl, setPageUrl] = useState(stored?.page?.url ?? "");
  const [pageProfile, setPageProfile] = useState(stored?.page?.profile ?? "");

  useEffect(() => {
    setPageUrl(stored?.page?.url ?? "");
    setPageProfile(stored?.page?.profile ?? "");
  }, [regionId, stored?.page?.url, stored?.page?.profile]);

  const writePage = (url: string, profile: string) => {
    const paths = stored?.paths;
    const page =
      url.trim() || profile.trim()
        ? {
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(profile.trim() ? { profile: profile.trim() } : {}),
          }
        : undefined;
    const next: RegionDefaults = {
      ...(page ? { page } : {}),
      ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
    };
    setRegionDefaults(regionId, Object.keys(next).length > 0 ? next : undefined);
  };

  const commit = () => writePage(pageUrl, pageProfile);

  const clearPage = () => {
    setPageUrl("");
    setPageProfile("");
    writePage("", "");
  };

  const onEnter = commitOnEnter(commit);
  const hasPageDefaults = Boolean(stored?.page?.url || stored?.page?.profile);

  return (
    <div className="inspector-section">
      <div className="inspector-detail mb-1">
        Applied when a new page node is created inside this region. Edit the node after create to override.
      </div>
      <label className="inspector-editor">
        <span>url</span>
        <input
          data-focus-owner="canvas-draft"
          aria-label="Region page url default"
          value={pageUrl}
          placeholder="https://…"
          onChange={(e) => setPageUrl(e.target.value)}
          onBlur={commit}
          onKeyDown={onEnter}
        />
      </label>
      <label className="inspector-editor">
        <span>profile</span>
        <BrowserProfileSelect
          ariaLabel="Region page profile default"
          value={pageProfile}
          allowNone
          onChange={(next) => {
            setPageProfile(next);
            writePage(pageUrl, next);
          }}
        />
      </label>
      {hasPageDefaults ? (
        <div className="inspector-flags" style={{ marginTop: 14 }}>
          <button type="button" className="inspector-flag-toggle" onClick={clearPage}>
            clear page defaults
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Region briefing — operator context for agents inside the region.
// Work-control `onboard` returns it via containingRegion; nothing injects it
// into agent turns. An empty briefing clears the field.
const commitRegionInstruction = (regionId: string, instruction: string): void => {
  const trimmed = instruction.trim();
  commitCommands((canvas) => regionEdited(canvas, regionId, { instruction: trimmed === "" ? null : trimmed }));
};

/** One region's briefing document: its draft, what it last saved, and what it takes in from elsewhere. */
function RegionBriefingDocument({ regionId }: { readonly regionId: string }) {
  const canvasName = use$(state$.canvasName);
  const instructionValue = useNodeOf(canvasName, regionId, "region")?.instruction ?? "";
  // What the field holds; what was last saved or received, as stored (trimmed).
  const [shown, setShown] = useState(instructionValue);
  const saved = useRef(instructionValue);
  const draft = useRef(instructionValue);

  useEffect(() => {
    if (instructionValue === saved.current) return;
    const unsaved = draft.current.trim() !== saved.current;
    saved.current = instructionValue;
    if (unsaved) return;
    draft.current = instructionValue;
    setShown(instructionValue);
  }, [instructionValue]);

  const save = (text: string): void => {
    // The store keeps the text trimmed: saving trailing space again is no change.
    if (text.trim() === saved.current) return;
    saved.current = text.trim();
    commitRegionInstruction(regionId, text);
  };

  return (
    <BriefingDocument
      canvasName={canvasName}
      regionId={asModelNodeId(regionId)}
      size="panel"
      canvasDraft
      value={shown}
      label="Region briefing"
      surfaceLabel="Region briefing, document"
      placeholder="What should agents inside this region know?"
      onChange={(text) => {
        draft.current = text;
        setShown(text);
      }}
      onRest={save}
    />
  );
}

/**
 * Region briefing — context agents receive on onboard, written as a document
 * (plan 0.11, 08): headings, lists, and mentions of what the region reaches.
 * Builds with the Tasks feature also author the region's rules and pinned
 * rulings beneath it: rules are statements a closing task must answer, so
 * they live with the briefing. Single copy line; CLI refs use first-class
 * amber mono.
 *
 * Typing is saved when it rests or the field is left. A briefing changed
 * elsewhere (an overseer, another machine) is taken in only while nothing
 * typed is unsaved.
 */
export function RegionBriefingEditor({ nodeId: regionId }: { readonly nodeId: string }) {
  return (
    <div className="region-briefing">
      <p className="region-briefing__hint">
        Agents receive this from the{" "}
        <span className="cli-cmd">onboard</span>
        {" "}command inside the region. @ names a seat, # a task or an artifact the region reaches.
      </p>
      {/* One region's draft never carries into the next. */}
      <RegionBriefingDocument key={regionId} regionId={regionId} />
      {/* Region rules ride the Tasks gate: a tasks-off build has none. */}
      {TASKS_ENABLED ? <RegionRules regionId={regionId} /> : null}
    </div>
  );
}
