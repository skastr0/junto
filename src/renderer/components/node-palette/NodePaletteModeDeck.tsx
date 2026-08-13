import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
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
import { AgentHarnessPick } from "./AgentHarnessPick";
import {
  NodeCatalogGrid,
  type NodeCatalogCategory,
  type NodeCatalogEntry,
} from "./NodeCatalogGrid";
import "./node-palette-mode-deck.css";

export type ModeDeckActions = {
  /** Geography only — note (text) and region (group). Page/image use dedicated adders. */
  readonly create: (kind: "text" | "group") => void;
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
  readonly addTerminal: () => void;
  readonly addHerdr: () => void;
  readonly addPage: () => void;
  readonly addLabel: () => void;
};

const CATEGORIES: ReadonlyArray<{ readonly id: NodeCatalogCategory | "all"; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "shell", label: "Shell" },
  { id: "sinks", label: "Work" },
  { id: "schedule", label: "Schedule" },
  { id: "canvas", label: "Canvas" },
];

const catalogAction = (actions: ModeDeckActions, entry: NodeCatalogEntry): void => {
  switch (entry.id) {
    case "terminal": actions.addTerminal(); break;
    case "herdr":
      // Catalog omits herdr when HERDR_ENABLED is false; no-op if reached.
      actions.addHerdr();
      break;
    case "tasks": actions.addTasks(); break;
    case "requests": actions.addRequests(); break;
    case "artifacts": actions.addArtifacts(); break;
    case "board": actions.addBoard(); break;
    case "pad": actions.addPad(); break;
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
  const [category, setCategory] = useState<NodeCatalogCategory | "all">("all");
  const [launchContext, setLaunchContext] = useState<AgentLaunchContextValue>(
    defaultAgentLaunchContext,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const configureAgent = useCallback((choices: AgentConfigurationChoices) => {
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
    <section className="node-deck" aria-label="Add canvas item" onWheel={(event) => event.stopPropagation()}>
      <div className="node-deck__search-row">
        <Search size={15} aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search nodes and agents…"
          aria-label="Search nodes and agents"
        />
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
          />
          <section
            className="node-deck__agent-wiring"
            aria-label="Agent connection summary"
          >
            <div className="node-deck__agent-route">
              <span>Agent</span>
              <ArrowRight size={13} aria-hidden />
              <strong>Tasks</strong>
              <small>claims and completes work</small>
            </div>
            <div className="node-deck__agent-secondary">
              <span>Also connects to Requests and Artifacts.</span>
            </div>
          </section>
          <div className="node-deck__launch-slot">
            <AgentLaunchContext
              position={agentPosition}
              onChange={setLaunchContext}
              className="node-deck__launch-context"
            />
          </div>
        </aside>
        <div className="node-deck__catalog">
          <div className="node-deck__pane-label"><span>Node catalog</span></div>
          <NodeCatalogGrid
            className="node-deck__catalog-grid"
            query={query}
            category={category}
            onSelect={(entry) => catalogAction(actions, entry)}
          />
        </div>
      </div>
    </section>
  );
}
