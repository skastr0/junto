/**
 * The window's model reads, and its one model write (junto/ipc.ts): the
 * canvas list, a canvas opened, a command, the compiled actor refs. The
 * renderer's raw arguments are decoded in here, so only structured-clone data
 * crosses the port.
 */
import { Effect, Schema } from "effect";
import { CanvasName, Command, type Opened } from "@shared/model";
import type { ActorRef } from "@shared/work-protocol";
import { ModelActorRefs } from "../../junto/model/actor-refs";
import { ModelService } from "../../junto/model/service";
import { commandReleasingSeats } from "../../junto/work/seat-release";
import { coreOps, type CoreOp } from "../ops";

/** What the canvas list answers: a name and when it last changed. */
type CanvasSummary = { readonly name: string; readonly modifiedAt: string };

declare module "../ops" {
  interface CoreOps {
    "ipc.model.canvases": CoreOp<Record<string, never>, ReadonlyArray<CanvasSummary>>;
    "ipc.model.open": CoreOp<{ readonly input: unknown }, Opened>;
    "ipc.model.command": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.model.actorRefs": CoreOp<{ readonly input: unknown }, ReadonlyArray<ActorRef>>;
  }
}

const ModelOpenInput = Schema.Struct({ canvas: CanvasName });

coreOps({
  "ipc.model.canvases": () => Effect.flatMap(ModelService, (model) => model.listCanvasSummaries()),
  "ipc.model.open": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(ModelOpenInput)(input, { onExcessProperty: "error" });
      return yield* (yield* ModelService).open(query.canvas);
    }),
  "ipc.model.command": ({ input }) =>
    Effect.gen(function* () {
      const command = yield* Schema.decodeUnknownEffect(Command)(input, { onExcessProperty: "error" });
      // A seat the command removes lets go of its task, and one it restores takes it back (seat-release.ts).
      return yield* commandReleasingSeats(command, "operator");
    }),
  "ipc.model.actorRefs": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* Schema.decodeUnknownEffect(ModelOpenInput)(input, { onExcessProperty: "error" });
      return yield* (yield* ModelActorRefs).read(query.canvas);
    }),
});
