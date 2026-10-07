import { useEffect, useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { TaskRule } from "@shared/work-model";
import { state$ } from "../../../lib/state";
import { useCanvas } from "../../../lib/use-model";
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
  // A task's path depends on every board and wire it could cross, so the
  // whole canvas is followed; this is mounted only while a task is being made.
  const canvas = useCanvas(use$(state$.canvasName));
  const path = useMemo(() => taskPath(canvas, nodeId), [canvas, nodeId]);
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
