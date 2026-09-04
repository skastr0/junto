import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { TaskRule } from "@shared/work-model";
import { state$ } from "../../../lib/state";
import { taskPath } from "./task-path";
import { pruneToPath, strandedRules } from "./task-path-rules";
import { TaskPath } from "./TaskPath";

export function TaskCreationPath({
  nodeId,
  rules = [],
  onRulesChange,
}: {
  readonly nodeId: string;
  readonly rules?: ReadonlyArray<TaskRule>;
  readonly onRulesChange?: (next: ReadonlyArray<TaskRule>) => void;
}) {
  const doc = use$(state$.doc);
  const path = useMemo(() => taskPath(doc, nodeId), [doc, nodeId]);
  useEffect(() => {
    if (onRulesChange && strandedRules(rules, path).length) {
      onRulesChange(pruneToPath(rules, path));
    }
  }, [onRulesChange, path, rules]);
  return path.length < 2 ? null : (
    <TaskPath
      path={path}
      rules={rules}
      onRulesChange={onRulesChange}
    />
  );
}
