import { Effect, Layer, Option } from "effect";
import { TaskRepository } from "../../src/main/junto/work/task-repository";

/** A task store with no tasks, for runtimes that read seat tasks but never rule one. */
export const NoTasksLive = Layer.succeed(
  TaskRepository,
  TaskRepository.of({
    list: () => Effect.succeed({ tasks: [], more: false }),
    get: () => Effect.succeed(Option.none()),
    submit: () => Effect.die(new Error("NoTasksLive rules no task")),
    precheck: () => Effect.succeed(Option.none()),
    overlay: () => Effect.succeed([]),
  }),
);
