import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Search } from "lucide-react";
import { asNodeId, type Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { addEdge } from "../../lib/edge-mutations";
import { claimFocus } from "../../lib/focus-ownership";
import { regionTrails, trailPath } from "../../lib/region-path";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { accentColor, INK } from "../../lib/theme";
import { AgentPortrait } from "../AgentPortrait";
import { RegionCrumb } from "../RegionCrumb";

/**
 * Connect this node to an agent anywhere on the canvas, however far: a search
 * box over a list of agents, each with its portrait and its region path. A
 * press (or Enter on the lit row) connects at once; the verb comes from the
 * pair. Only agents are offered, and never one this node already reaches.
 */
export function ConnectEditor({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    claimFocus(inputRef.current, "open");
  }, []);

  const canvas = useCanvas(use$(state$.canvasName));
  const node = canvas.nodes.get(asNodeId(nodeId));
  const name = node ? titleOf(node) : nodeId;
  const trailById = useMemo(() => regionTrails(canvas), [canvas]);
  const agents = useMemo(
    () =>
      [...canvas.nodes.values()].filter(
        (candidate) =>
          candidate.id !== nodeId &&
          candidate.kind === "agent" &&
          ![...canvas.wires.values()].some((wire) => wire.from === nodeId && wire.to === candidate.id),
      ),
    [canvas, nodeId],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? agents.filter((agent) =>
        `${titleOf(agent)} ${trailPath(trailById.get(agent.id) ?? [])}`.toLowerCase().includes(needle),
      )
    : agents;
  const lit = Math.min(active, matches.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [lit]);

  const connect = (target: Node | undefined): void => {
    if (!target) return;
    addEdge({ source: nodeId, target: target.id });
    onClose();
  };

  return (
    <div className="connect-pick" data-testid="connect-pick">
      <div className="connect-pick__search">
        <Search size={13} aria-hidden />
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="connect-pick-list"
          aria-label={`Connect ${name} to an agent`}
          data-testid="connect-pick-input"
          value={query}
          placeholder={`connect ${name} to`}
          spellCheck={false}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(Math.max(0, Math.min(lit + step, matches.length - 1)));
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              connect(matches[lit]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
      </div>
      {matches.length === 0 ? (
        <div className="connect-pick__empty">
          {agents.length === 0 ? "Already connected to every agent" : "No agent matches"}
        </div>
      ) : (
        <div className="connect-pick__list" id="connect-pick-list" role="listbox" ref={listRef}>
          {matches.map((agent, index) => {
            const trail = trailById.get(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={index === lit}
                className="connect-pick__row"
                data-node-id={agent.id}
                data-testid="connect-pick-row"
                onPointerMove={() => setActive(index)}
                onClick={() => connect(agent)}
              >
                <AgentPortrait identity={agent.id} size={24} frame="round" outline={false} badge={false} />
                <span
                  className="connect-pick__name"
                  style={{ color: agent.color ? accentColor(agent.color) : INK }}
                >
                  {titleOf(agent)}
                </span>
                {trail ? <RegionCrumb trail={trail} className="connect-pick__crumb" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
