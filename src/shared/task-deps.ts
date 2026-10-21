import type { Task } from "./work-model";
import { claimedByOf } from "./task";

/**
 * Work-plane task dependencies (hard prereqs; scope is supplied by the
 * caller — typically same-region via dependencyScopeIndex).
 *
 * Parallel default: omit / empty dependsOn → immediately claim-ready.
 * Join is ALL; only `completed` satisfies an edge.
 */

const uniqueIds = (ids: ReadonlyArray<string>): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

const MAX_TASK_ID_LENGTH = 256;

/**
 * Normalize decoded historical/read-model input: trim, drop empties, de-dupe,
 * and preserve order.
 */
const normalizeDependsOn = (
  dependsOn: ReadonlyArray<string> | undefined,
): string[] | undefined => {
  if (dependsOn === undefined) return undefined;
  const cleaned = uniqueIds(
    dependsOn.map((id) => id.trim()).filter((id) => id.length > 0),
  );
  return cleaned.length === 0 ? undefined : cleaned;
};

const isDepSatisfied = (dep: Task): boolean => dep.state === "completed";

/** Direct deps all completed (claim gate — non-recursive). */
export const taskIsClaimReady = (
  task: Task,
  byId: ReadonlyMap<string, Task>,
): boolean => {
  if (task.state !== "submitted" || claimedByOf(task) !== undefined) {
    return false;
  }
  const deps = task.dependsOn ?? [];
  if (deps.length === 0) return true;
  for (const id of deps) {
    const dep = byId.get(id);
    if (dep === undefined || !isDepSatisfied(dep)) return false;
  }
  return true;
};

/**
 * Index task rows by id. A send-on leaves two rows sharing a task id
 * (the completed source visit + the re-homed successor) — completed is
 * sticky over a duplicate: local visit completion satisfies dependsOn
 * regardless of the task's downstream fate, so a `completed` row is never
 * displaced by a later same-id row in another state. Otherwise last wins.
 */
export const taskIndexById = (
  items: ReadonlyArray<Task>,
): Map<string, Task> => {
  const map = new Map<string, Task>();
  for (const item of items) {
    const existing = map.get(item.id);
    if (existing?.state === "completed" && item.state !== "completed") {
      continue;
    }
    map.set(item.id, item);
  }
  return map;
};

/**
 * Validate dependsOn for a task being created or rewired.
 * Returns an error message or undefined when ok.
 */
export const validateTaskDependsOn = (params: {
  readonly taskId: string;
  readonly dependsOn: ReadonlyArray<string> | undefined;
  readonly byId: ReadonlyMap<string, Task>;
  /** When true, every dep id must already exist in the dependency scope. */
  readonly requireExisting?: boolean;
}): string | undefined => {
  const deps = normalizeDependsOn(params.dependsOn);
  if (deps === undefined) return undefined;
  if (deps.includes(params.taskId)) {
    return `task "${params.taskId}" cannot depend on itself`;
  }
  const seenAuthoredIds = new Set<string>();
  for (const rawId of params.dependsOn ?? []) {
    const id = rawId.trim();
    if (id.length === 0) continue;
    if (seenAuthoredIds.has(id)) {
      return `dependsOn contains duplicate task "${id}"`;
    }
    seenAuthoredIds.add(id);
  }
  for (const id of deps) {
    if (id.length > MAX_TASK_ID_LENGTH) {
      return `dependsOn id too long: ${id.slice(0, 32)}…`;
    }
    if (params.requireExisting !== false && !params.byId.has(id)) {
      return `dependsOn references missing task "${id}"`;
    }
  }
  // Cycle: following dependsOn edges from deps must not reach taskId.
  const stack = [...deps];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === params.taskId) {
      return `dependsOn would create a cycle involving "${params.taskId}"`;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const node = params.byId.get(id);
    if (!node?.dependsOn) continue;
    for (const next of node.dependsOn) stack.push(next);
  }
  return undefined;
};
