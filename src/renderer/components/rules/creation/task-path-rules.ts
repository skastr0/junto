import type { Rule, TaskRule } from "@shared/work-model";
import type { RuleInForce } from "@shared/rules";
import type { TaskPathNode } from "./task-path";

export const rulesAt = (
  rules: ReadonlyArray<TaskRule>,
  board: string,
): ReadonlyArray<TaskRule> => rules.filter((rule) => rule.board === board);

export const replaceRulesAt = (
  rules: ReadonlyArray<TaskRule>,
  board: string,
  next: ReadonlyArray<Rule>,
): ReadonlyArray<TaskRule> => [
  ...rules.filter((rule) => rule.board !== board),
  ...next.map((rule) => ({ ...rule, board })),
];

export const strandedRules = (
  rules: ReadonlyArray<TaskRule>,
  path: ReadonlyArray<TaskPathNode>,
): ReadonlyArray<TaskRule> => {
  const boards = new Set(path.map((entry) => entry.nodeId));
  return rules.filter((rule) => !boards.has(rule.board));
};

export const pruneToPath = (
  rules: ReadonlyArray<TaskRule>,
  path: ReadonlyArray<TaskPathNode>,
): ReadonlyArray<TaskRule> => {
  const boards = new Set(path.map((entry) => entry.nodeId));
  return rules.filter((rule) => boards.has(rule.board));
};

const ruleIdentity = ({ rule, provenance }: RuleInForce): string => {
  switch (provenance.kind) {
    case "region":
      return `region:${provenance.regionId}:${rule.id}`;
    case "board":
      return `board:${provenance.boardId}:${rule.id}`;
    case "task":
      return `task:${provenance.board}:${rule.id}`;
  }
};

/** Structural rules that occur anywhere on the path, listed once per authoring scope. */
export const pathRules = (
  path: ReadonlyArray<TaskPathNode>,
): ReadonlyArray<RuleInForce> => {
  const seen = new Set<string>();
  return path.flatMap((entry) =>
    entry.rules.filter((rule) => {
      const identity = ruleIdentity(rule);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }),
  );
};

export const formatProfile = (
  path: ReadonlyArray<TaskPathNode>,
  rules: ReadonlyArray<TaskRule> = [],
): string => {
  const count = pathRules(path).length + rules.length;
  return `${path.length} ${path.length === 1 ? "board" : "boards"}, ${count} ${count === 1 ? "rule" : "rules"}`;
};
