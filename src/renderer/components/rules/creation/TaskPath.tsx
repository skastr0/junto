import { useState } from "react";
import type { Rule, TaskRule } from "@shared/work-model";
import { RuleList } from "../RuleList";
import { TaskPathCard } from "./TaskPathCard";
import {
  formatDepth,
  groupPathByDepth,
  type TaskPathNode,
} from "./task-path";
import {
  formatProfile,
  pathRules,
  replaceRulesAt,
  rulesAt,
  strandedRules,
} from "./task-path-rules";
import "./task-path.css";

export function TaskPath({
  path,
  rules = [],
  onRulesChange,
}: {
  readonly path: ReadonlyArray<TaskPathNode>;
  readonly rules?: ReadonlyArray<TaskRule>;
  readonly onRulesChange?: (next: ReadonlyArray<TaskRule>) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const selected = path.find((entry) => entry.nodeId === active);
  const stranded = strandedRules(rules, path);
  const structuralRules = pathRules(path);
  const stages = groupPathByDepth(path);

  return (
    <section className="task-path" aria-label="Task path">
      <header>{formatProfile(path, rules)}</header>
      {stranded.length ? (
        <p role="alert">{stranded.length} rules refer to a board outside this path.</p>
      ) : null}
      {structuralRules.length > 0 ? (
        <ul className="task-path__rules" aria-label="Rules in path">
          {structuralRules.map((entry, index) => (
            <li key={`${entry.provenance.kind}-${entry.rule.id}-${index}`}>
              {entry.rule.text}
            </li>
          ))}
        </ul>
      ) : null}
      <ol className="task-path__stages" data-testid="task-path-boards">
        {stages.map((stage, stageIndex) => (
          <li
            key={`${stage.depth}:${stage.parents.join(",")}`}
            className="task-path__stage"
            data-branch={String(stage.boards.length > 1)}
            data-first={String(stageIndex === 0)}
            data-last={String(stageIndex === stages.length - 1)}
          >
            <span className="task-path__stage-label">
              {formatDepth(stage.depth)}
            </span>
            <ol className="task-path__stage-boards">
              {stage.boards.map((node) => {
                const taskRules = rulesAt(rules, node.nodeId);
                return (
                  <li key={node.nodeId} className="task-path__stage-board">
                    <TaskPathCard
                      node={node}
                      expanded={active === node.nodeId}
                      ruleCount={taskRules.length}
                      editable={onRulesChange !== undefined}
                      onToggle={() =>
                        setActive(active === node.nodeId ? null : node.nodeId)
                      }
                    />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      {selected && onRulesChange ? (
        <div
          id={`task-path-board-${selected.nodeId}`}
          className="task-path__board-detail"
        >
          <RuleList
            rules={rulesAt(rules, selected.nodeId)}
            label={`Rules at ${selected.label}`}
            onChange={(next: ReadonlyArray<Rule>) =>
              onRulesChange(replaceRulesAt(rules, selected.nodeId, next))
            }
          />
        </div>
      ) : null}
    </section>
  );
}
