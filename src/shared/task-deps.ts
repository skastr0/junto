import type { Task } from "./work-model";
import { claimedByOf, isTerminalTaskState } from "./task";

/**
 * Work-plane task dependencies (hard prereqs; scope is supplied by the
 * caller — typically same-region via dependencyScopeIndex).
 *
 * Parallel default: omit / empty dependsOn → immediately claim-ready.
 * Join is ALL; only `completed` satisfies an edge.
 * depStatus is a read-model walk — never mutates Task.state.
 */

export type TaskDepStatus =
  | { readonly kind: "ready" }
  | {
      readonly kind: "waiting";
      /** Incomplete deps that are claimable or actively in progress. */
      readonly frontier: ReadonlyArray<string>;
    }
  | {
      readonly kind: "blocked";
      /** Failed / canceled / rejected ancestors that pin this task. */
      readonly roots: ReadonlyArray<string>;
    }
  | {
      readonly kind: "orphan";
      readonly missing: ReadonlyArray<string>;
    };

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

const MAX_TASK_DEPENDENCY_IDS = 256;
const MAX_TASK_ID_LENGTH = 256;

/**
 * Strict authoring boundary. New dependency IDs must already be canonical;
 * normalization below exists only for decoded historical/read-model input.
 */
export const validateAuthoredTaskDependsOn = (
  dependsOn: ReadonlyArray<string> | undefined,
): string | undefined => {
  if (dependsOn === undefined) return undefined;
  if (dependsOn.length > MAX_TASK_DEPENDENCY_IDS) {
    return `dependsOn contains ${dependsOn.length} Task ids; maximum is ${MAX_TASK_DEPENDENCY_IDS}`;
  }
  const seen = new Set<string>();
  for (const value of dependsOn as ReadonlyArray<unknown>) {
    if (typeof value !== "string" || value.length === 0) {
      return "dependsOn entries must be non-empty canonical Task ids";
    }
    const canonical = value.trim();
    if (canonical.length === 0) {
      return "dependsOn entries must be non-empty canonical Task ids";
    }
    if (value !== canonical) {
      return `dependsOn task id ${JSON.stringify(value)} is not canonical`;
    }
    if (value.length > MAX_TASK_ID_LENGTH) {
      return `dependsOn task id ${JSON.stringify(value.slice(0, 32))} is too long`;
    }
    if (seen.has(canonical)) {
      return `dependsOn contains duplicate task ${JSON.stringify(canonical)}`;
    }
    seen.add(canonical);
  }
  return undefined;
};

/**
 * Normalize decoded historical/read-model input: trim, drop empties, de-dupe,
 * and preserve order. Authoring must pass validateAuthoredTaskDependsOn first.
 */
export const normalizeDependsOn = (
  dependsOn: ReadonlyArray<string> | undefined,
): string[] | undefined => {
  if (dependsOn === undefined) return undefined;
  const cleaned = uniqueIds(
    dependsOn.map((id) => id.trim()).filter((id) => id.length > 0),
  );
  return cleaned.length === 0 ? undefined : cleaned;
};

export const isDepSatisfied = (dep: Task): boolean => dep.state === "completed";

export const isDepBroken = (dep: Task): boolean =>
  dep.state === "failed" ||
  dep.state === "canceled" ||
  dep.state === "rejected";

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

const isDepAvailable = (
  dep: Task,
  byId: ReadonlyMap<string, Task>,
): boolean => {
  if (isDepSatisfied(dep) || isDepBroken(dep)) return false;
  if (
    dep.state === "working" ||
    dep.state === "input-required" ||
    dep.state === "auth-required"
  ) {
    return true;
  }
  // submitted (+ maybe claimed illegally) — available if its own deps are met
  if (dep.state === "submitted") {
    return taskIsClaimReady(dep, byId) || claimedByOf(dep) !== undefined;
  }
  return false;
};

/**
 * Recursive glance: collapse waiting chains to the frontier of work that
 * exists now (ready / active), or broken roots. Does not rewrite task state.
 */
export const taskDepStatus = (
  task: Task,
  byId: ReadonlyMap<string, Task>,
  visited: ReadonlySet<string> = new Set(),
): TaskDepStatus => {
  if (taskIsClaimReady(task, byId)) return { kind: "ready" };

  // Already running or terminal — not a queue readiness question.
  if (task.state !== "submitted" || claimedByOf(task) !== undefined) {
    if (isTerminalTaskState(task.state) && task.state === "completed") {
      return { kind: "ready" };
    }
  }

  const deps = task.dependsOn ?? [];
  // No hard edges: not waiting on the graph (active/terminal handled above).
  if (deps.length === 0) return { kind: "ready" };

  if (visited.has(task.id)) {
    // Cycle should be rejected at write; treat as orphan-ish for safety.
    return { kind: "orphan", missing: [task.id] };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(task.id);

  const missing: string[] = [];
  const broken: string[] = [];
  const frontier: string[] = [];

  for (const id of deps) {
    const dep = byId.get(id);
    if (dep === undefined) {
      missing.push(id);
      continue;
    }
    if (isDepSatisfied(dep)) continue;
    if (isDepBroken(dep)) {
      broken.push(id);
      continue;
    }
    if (isDepAvailable(dep, byId)) {
      frontier.push(id);
      continue;
    }
    // waiting — recurse
    const child = taskDepStatus(dep, byId, nextVisited);
    if (child.kind === "orphan") missing.push(...child.missing);
    else if (child.kind === "blocked") broken.push(...child.roots);
    else if (child.kind === "waiting") frontier.push(...child.frontier);
    // ready child with unsatisfied parent path shouldn't happen mid-walk
  }

  if (missing.length > 0) {
    return { kind: "orphan", missing: uniqueIds(missing) };
  }
  if (broken.length > 0) {
    return { kind: "blocked", roots: uniqueIds(broken) };
  }
  if (frontier.length > 0) {
    return { kind: "waiting", frontier: uniqueIds(frontier) };
  }
  // All direct deps satisfied but task not claim-ready (e.g. wrong state)
  return { kind: "ready" };
};

/**
 * Index sink items by id. A forward leaves two live rows sharing a task id
 * (the closed source passage + the re-homed successor) — completed is
 * sticky over a duplicate: local passage completion satisfies dependsOn
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
