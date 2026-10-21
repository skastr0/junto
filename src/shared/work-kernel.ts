import type { Task } from "./work-model";

/** Work facts used by scheduling; topology and mail have separate streams. */
export type KernelWork = {
  readonly tasks: ReadonlyMap<string, ReadonlyArray<Task>>;
  readonly artifacts: ReadonlyMap<string, number>;
};
