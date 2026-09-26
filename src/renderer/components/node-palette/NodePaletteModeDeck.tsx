import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search } from "lucide-react";
import {
  AgentLaunchContext,
  defaultAgentLaunchContext,
  type AgentLaunchContextValue,
} from "./AgentLaunchContext";
import {
  withHarnessSettingsDefaults,
  type AgentConfigurationChoices,
} from "./agent-launch-model";
import { state$ } from "../../lib/state";
import {
  AgentHarnessPick,
  type CascadeDismiss,
} from "./AgentHarnessPick";
import {
  DEFAULT_NODE_CATALOG_ENTRIES,
  NodeCatalogGrid,
  type NodeCatalogCategory,
  type NodeCatalogEntry,
} from "./NodeCatalogGrid";
import { SquadPickerSection } from "../squads/SquadPickerSection";
import { ProfilePickerSection } from "../profiles/ProfilePickerSection";
import type { PlaceOutcome } from "../../lib/squads-state";
import type { SquadLaunch } from "../../lib/squads";
import "./node-palette-mode-deck.css";
import { claimFocus } from "../../lib/focus-ownership";

export type ModeDeckActions = {
  /** Geography only — note (text) and region (group). Page/image use dedicated adders. */
  readonly create: (kind: "text" | "group") => void;
  /** Place a saved squad (fresh seats, connections, layout). */
  readonly addSquad: (squadId: string, launch: SquadLaunch) => Promise<PlaceOutcome>;
  /** Place a saved agent profile as a fresh seat. */
  readonly addProfile: (profileId: string, launch: SquadLaunch) => Promise<PlaceOutcome>;
  /** Build a new profile in the customize editor; no seat is made. */
  readonly createProfile: () => void;
  readonly addConfiguredAgent: (
    choices: AgentConfigurationChoices & AgentLaunchContextValue,
    position: { readonly x: number; readonly y: number },
  ) => void;

  readonly addCron: () => void;
  readonly addRelay: () => void;
  readonly addTasks: () => void;
  readonly addRequests: () => void;
  readonly addArtifacts: () => void;
  readonly addBoard: () => void;
  readonly addPad: () => void;
  readonly addSheet: () => void;
  readonly addGit: () => void;
  readonly addTerminal: () => void;
  readonly addPage: () => void;
  readonly addLabel: () => void;
};

type DeckTab = NodeCatalogCategory | "all" | "profiles";

// A tab only appears when this build ships something under it: a ship build
// without cron or relay has no Schedule tab to open onto an empty grid. All
// shows profiles, squads, and the catalog; Profiles only profiles; a catalog
// tab only its nodes.
const CATEGORIES: ReadonlyArray<{ readonly id: DeckTab; readonly label: string }> = [
  { id: "all" as const, label: "All" },
  { id: "profiles" as const, label: "Profiles" },
  { id: "shell" as const, label: "Shell" },
  { id: "sinks" as const, label: "Work" },
  { id: "schedule" as const, label: "Schedule" },
  { id: "canvas" as const, label: "Canvas" },
].filter((tab) =>
  tab.id === "all" || tab.id === "profiles" || DEFAULT_NODE_CATALOG_ENTRIES.some((entry) => entry.category === tab.id));

const catalogAction = (actions: ModeDeckActions, entry: NodeCatalogEntry): void => {
  switch (entry.id) {
    case "terminal": actions.addTerminal(); break;
    case "tasks": actions.addTasks(); break;
    case "requests": actions.addRequests(); break;
    case "artifacts": actions.addArtifacts(); break;
    case "board": actions.addBoard(); break;
    case "pad": actions.addPad(); break;
    case "sheet": actions.addSheet(); break;
    case "git": actions.addGit(); break;
    case "page": actions.addPage(); break;
    case "cron": actions.addCron(); break;
    case "relay": actions.addRelay(); break;
    case "note": actions.create("text"); break;
    case "label": actions.addLabel(); break;
    case "region": actions.create("group"); break;
  }
};

/**
 * A single, broad add surface: agents configure in place on the left while
 * node choices remain browsable on the right. The agent cascade is anchored
 * to its row, so model/effort never reads as catalog-level configuration.
 */
export function NodePaletteModeDeck({
  actions,
  agentPosition,
}: {
  readonly actions: ModeDeckActions;
  readonly agentPosition: { readonly x: number; readonly y: number };
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<DeckTab>("all");
  const [launchContext, setLaunchContext] = useState<AgentLaunchContextValue>(
    defaultAgentLaunchContext,
  );
  // Owned here so a create attempt with no working directory can open the
  // picker (see configureAgent) instead of minting a seat that cannot start.
  const [folderOpen, setFolderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deckRef = useRef<HTMLElement>(null);
  const cascadeDismissRef = useRef<CascadeDismiss | null>(null);
  const hintId = useId();

  useEffect(() => {
    claimFocus(inputRef.current, "open");
  }, []);

  const focusFirstResult = (): void => {
    const deck = deckRef.current;
    if (!deck) return;
    const candidates = deck.querySelectorAll<HTMLElement>(
      ".agent-harness-pick__item, .profile-picker__card, .node-deck-catalog__card",
    );
    for (const candidate of candidates) {
      if (candidate.getClientRects().length === 0) continue;
      claimFocus(candidate, "gesture");
      return;
    }
  };

  const onSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "Escape") {
      if (cascadeDismissRef.current?.()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      cascadeDismissRef.current?.();
      focusFirstResult();
    }
  };

  // Squads and profiles land with the launch context's host and folder. A
  // region's default folder wins inside it; with no folder at all the
  // placement asks for one, like a new agent does.
  const placeWithLaunch = useCallback(
    (place: (id: string, launch: SquadLaunch) => Promise<PlaceOutcome>) => (id: string) => {
      const cwd = launchContext.cwd.trim();
      void place(id, {
        host: launchContext.host,
        agentHost: launchContext.agentHost,
        ...(cwd ? { cwd } : {}),
      }).then((outcome) => {
        if (outcome === "needs-folder") setFolderOpen(true);
      });
    },
    [launchContext],
  );

  const configureAgent = useCallback((choices: AgentConfigurationChoices) => {
    // A managed agent seat must name its working directory: main refuses a
    // seat without one, since the fallback is the operator home. Answer the
    // create attempt with the folder picker rather than minting a seat that
    // can only fail at spawn.
    if (!launchContext.cwd.trim()) {
      setFolderOpen(true);
      return;
    }
    const withDefaults = withHarnessSettingsDefaults(
      choices,
      state$.settings.get(),
    );
    actions.addConfiguredAgent({
      ...withDefaults,
      ...launchContext,
    }, agentPosition);
  }, [actions, agentPosition, launchContext]);

  return (
    <section
      ref={deckRef}
      className="node-deck"
      aria-label="Add canvas item"
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="node-deck__search-row">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search nodes and agents…"
          aria-label="Search nodes and agents"
          aria-describedby={hintId}
        />
        <span id={hintId} className="sr-only">
          Press Down or Enter to browse results. Activation is a second step.
        </span>
      </div>
      <div className="node-deck__tabs" role="tablist" aria-label="Node categories">
        {CATEGORIES.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={category === tab.id}
            className={category === tab.id ? "is-selected" : undefined}
            onClick={() => setCategory(tab.id)}
          >{tab.label}</button>
        ))}
      </div>
      <div className="node-deck__body">
        <aside className="node-deck__agents" aria-label="Agents">
          <div className="node-deck__pane-label"><span>Agents</span></div>
          <AgentHarnessPick
            className="node-deck__harness-pick"
            query={query}
            listLabel="Agents"
            onConfigure={configureAgent}
            cascadeDismissRef={cascadeDismissRef}
          />
          <div className="node-deck__launch-slot">
            <AgentLaunchContext
              position={agentPosition}
              onChange={setLaunchContext}
              folderOpen={folderOpen}
              onFolderOpenChange={setFolderOpen}
              className="node-deck__launch-context"
            />
          </div>
        </aside>
        <div className="node-deck__catalog">
          {category === "all" || category === "profiles" ? (
            <ProfilePickerSection
              query={query}
              onPlace={placeWithLaunch(actions.addProfile)}
              onCreate={actions.createProfile}
            />
          ) : null}
          {category === "all" ? (
            <SquadPickerSection query={query} onPlace={placeWithLaunch(actions.addSquad)} />
          ) : null}
          {category !== "profiles" ? (
            <>
              <div className="node-deck__pane-label"><span>Node catalog</span></div>
              <NodeCatalogGrid
                className="node-deck__catalog-grid"
                query={query}
                category={category}
                onSelect={(entry) => catalogAction(actions, entry)}
              />
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
