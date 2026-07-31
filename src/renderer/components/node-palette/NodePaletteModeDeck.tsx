import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { allTemplates, type HarnessId } from "@shared/managed-terminal-templates";
import { HUE } from "../../lib/theme";
import {
  AgentCascadeMenu,
  cascadeEnterKey,
  cascadeSideFor,
  type AgentConfigurationChoices,
} from "../terminal/AgentCascadeMenu";
import { HarnessMark } from "../herdr/HarnessMark";
import {
  AgentLaunchContext,
  defaultAgentLaunchContext,
  type AgentLaunchContextValue,
} from "./AgentLaunchContext";
import {
  NodeCatalogGrid,
  type NodeCatalogCategory,
  type NodeCatalogEntry,
} from "./NodeCatalogGrid";
import "./node-palette-mode-deck.css";

export type ModeDeckActions = {
  readonly create: (kind: "text" | "file" | "link" | "group") => void;
  readonly addConfiguredAgent: (
    choices: AgentConfigurationChoices & AgentLaunchContextValue,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly addGauge: () => void;
  readonly addCron: () => void;
  readonly addTasks: () => void;
  readonly addRequests: () => void;
  readonly addArtifacts: () => void;
  readonly addBoard: () => void;
  readonly addTerminal: () => void;
  readonly addHerdr: () => void;
  readonly addPage: () => void;
};

const CATEGORIES: ReadonlyArray<{ readonly id: NodeCatalogCategory | "all" | "agents"; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "shell", label: "Shell" },
  { id: "sinks", label: "Sinks" },
  { id: "schedule", label: "Schedule" },
  { id: "canvas", label: "Canvas" },
];

const AGENT_ACCENTS: Readonly<Record<HarnessId, string>> = {
  claude: "#D97757",
  codex: HUE.cyan,
  grok: HUE.gold,
  hermes: HUE.violet,
};

const catalogAction = (actions: ModeDeckActions, entry: NodeCatalogEntry): void => {
  switch (entry.id) {
    case "terminal": actions.addTerminal(); break;
    case "herdr": actions.addHerdr(); break;
    case "tasks": actions.addTasks(); break;
    case "requests": actions.addRequests(); break;
    case "artifacts": actions.addArtifacts(); break;
    case "board": actions.addBoard(); break;
    case "page": actions.addPage(); break;
    case "watcher": actions.addGauge(); break;
    case "timer": actions.addCron(); break;
    case "note": actions.create("text"); break;
    case "file": actions.create("file"); break;
    case "link": actions.create("link"); break;
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
  const [category, setCategory] = useState<NodeCatalogCategory | "all" | "agents">("all");
  const [launchContext, setLaunchContext] = useState<AgentLaunchContextValue>(
    defaultAgentLaunchContext,
  );
  const [agentCascade, setAgentCascade] = useState<{
    readonly harness: HarnessId;
    readonly anchor: HTMLButtonElement;
    readonly focusOnOpen: boolean;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cascadeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (cascadeCloseTimer.current) clearTimeout(cascadeCloseTimer.current);
    };
  }, []);

  const keepCascadeOpen = useCallback(() => {
    if (!cascadeCloseTimer.current) return;
    clearTimeout(cascadeCloseTimer.current);
    cascadeCloseTimer.current = null;
  }, []);
  const closeCascade = useCallback(() => {
    keepCascadeOpen();
    setAgentCascade(null);
  }, [keepCascadeOpen]);
  const closeCascadeSoon = useCallback(() => {
    keepCascadeOpen();
    cascadeCloseTimer.current = setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".agent-cascade, .node-deck")) return;
      setAgentCascade(null);
    }, 140);
  }, [keepCascadeOpen]);
  const openCascade = useCallback((harness: HarnessId, anchor: HTMLButtonElement, focusOnOpen = false) => {
    keepCascadeOpen();
    setAgentCascade({ harness, anchor, focusOnOpen });
  }, [keepCascadeOpen]);
  const exitCascade = useCallback(() => {
    const anchor = agentCascade?.anchor;
    closeCascade();
    requestAnimationFrame(() => (anchor?.isConnected ? anchor : inputRef.current)?.focus());
  }, [agentCascade?.anchor, closeCascade]);

  const configureAgent = useCallback((choices: AgentConfigurationChoices) => {
    actions.addConfiguredAgent({
      ...choices,
      ...launchContext,
    }, agentPosition);
  }, [actions, agentPosition, launchContext]);
  const matchingTemplates = allTemplates().filter((template) =>
    !query.trim() || template.displayName.toLowerCase().includes(query.trim().toLowerCase()),
  );

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
          <div className="node-deck__pane-label"><span>Agents</span><span>configure</span></div>
          <div className="node-deck__agent-list" role="list">
            {matchingTemplates.map((template) => {
              const selected = agentCascade?.harness === template.harness;
              return (
                <div key={template.harness} role="listitem">
                <button
                  type="button"
                  className={`node-deck__agent${selected ? " is-expanded" : ""}`}
                  aria-label={`Add ${template.displayName} agent`}
                  aria-haspopup="menu"
                  aria-expanded={selected}
                  onFocus={(event) => openCascade(template.harness, event.currentTarget)}
                  onBlur={closeCascadeSoon}
                  onMouseEnter={(event) => openCascade(template.harness, event.currentTarget)}
                  onMouseLeave={closeCascadeSoon}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === cascadeEnterKey(cascadeSideFor(event.currentTarget))) {
                      event.preventDefault();
                      openCascade(template.harness, event.currentTarget, true);
                    }
                  }}
                  onClick={() => configureAgent({ harness: template.harness })}
                >
                  <HarnessMark
                    agent={template.harness}
                    size={28}
                    title={false}
                    treatment="neutral"
                    hue={AGENT_ACCENTS[template.harness]}
                  />
                  <span><strong>{template.displayName}</strong><small>template defaults</small></span>
                </button>
                </div>
              );
            })}
          </div>
          <div className="node-deck__launch-slot">
            <AgentLaunchContext
              position={agentPosition}
              onChange={setLaunchContext}
              className="node-deck__launch-context"
            />
          </div>
        </aside>
        <div className="node-deck__catalog">
          <div className="node-deck__pane-label"><span>Node catalog</span><span>click to add</span></div>
          {category === "agents" ? (
            <div className="node-deck__catalog-empty">Choose an agent from the adjacent list.</div>
          ) : (
            <NodeCatalogGrid
              className="node-deck__catalog-grid"
              query={query}
              category={category}
              onSelect={(entry) => catalogAction(actions, entry)}
            />
          )}
        </div>
      </div>
      {agentCascade ? (
        <AgentCascadeMenu
          key={agentCascade.harness}
          harness={agentCascade.harness}
          anchor={agentCascade.anchor}
          focusOnOpen={agentCascade.focusOnOpen}
          onConfigure={configureAgent}
          onPointerEnter={keepCascadeOpen}
          onPointerLeave={closeCascadeSoon}
          onExit={exitCascade}
        />
      ) : null}
    </section>
  );
}
