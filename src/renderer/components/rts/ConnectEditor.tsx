import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { addEdge } from "../../lib/edge-mutations";
import { claimFocus } from "../../lib/focus-ownership";
import { nodeTitle } from "../../lib/presentation";
import { regionTrails, trailPath } from "../../lib/region-path";
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
  node,
  doc,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly doc: CanvasDoc;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    claimFocus(inputRef.current, "open");
  }, []);

  const trailById = useMemo(() => regionTrails(doc), [doc]);
  const agents = useMemo(
    () =>
      doc.nodes.filter(
        (candidate) =>
          candidate.id !== node.id &&
          candidate.ether?.entity?.kind === "agent" &&
          !doc.edges.some((edge) => edge.fromNode === node.id && edge.toNode === candidate.id),
      ),
    [doc, node.id],
  );
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? agents.filter((agent) =>
        `${nodeTitle(agent)} ${trailPath(trailById.get(agent.id) ?? [])}`.toLowerCase().includes(needle),
      )
    : agents;
  const lit = Math.min(active, matches.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [lit]);

  const connect = (target: CanvasNode | undefined): void => {
    if (!target) return;
    addEdge({ source: node.id, target: target.id });
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
          aria-label={`Connect ${nodeTitle(node)} to an agent`}
          data-testid="connect-pick-input"
          value={query}
          placeholder={`connect ${nodeTitle(node)} to`}
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
                  {nodeTitle(agent)}
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
