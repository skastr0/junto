import { Effect } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import { operatorReachesResource, type ContentPullRefused, type ContentPullRequest } from "@shared/content-pull";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/model/base";
import type { ContentRef } from "@shared/wire/content-ref";
import type { CanvasPlacement } from "@shared/work-exchange";
import { admitContentWrite } from "../content/disk-admission";
import { ContentPullFailed, pullContent, type PulledOwner } from "../content/pull";
import { judgeArrivedSignalFile } from "./file-puller";
import { signalFileRefs } from "./taken-attachments";

export type SignalFilePullDeps = {
  readonly self: InstallationId;
  readonly placement: (canvasName: string) => Effect.Effect<CanvasPlacement | undefined>;
  /** The link name of a machine this one has set up, by its installation. */
  readonly machineName: (machine: InstallationId) => Effect.Effect<string | undefined>;
  /** Ask that machine for one piece over the link's content channel. */
  readonly ask: (machineName: string, request: ContentPullRequest) => Effect.Effect<unknown, unknown>;
  /** This machine's content store. */
  readonly root: string;
  readonly keep: (ref: ContentRef, owner: PulledOwner) => Effect.Effect<void, unknown>;
  /** Record every part of the signal naming that object as `mediaType`. */
  readonly judged: (signalId: string, object: ContentRef, mediaType: string) => Effect.Effect<unknown, unknown>;
  readonly once?: <E>(ref: ContentRef, transfer: Effect.Effect<void, E>) => Effect.Effect<void, E>;
  /** Test hook for the free-space probe; production reads the volume. */
  readonly freeBytes?: number;
};

/** The owner a signal's file is kept under, here as on the seat's machine: the signal, by its id. */
export const signalFileOwner = (signal: Pick<AgentSignal, "canvasName" | "nodeId" | "signalId">): PulledOwner => ({
  kind: "signal",
  canvasName: signal.canvasName,
  nodeId: signal.nodeId,
  recordId: signal.signalId,
});

/**
 * On the machine that edits the canvas: bring a file a seat's signal
 * attached here from the machine the seat lives on, keep it under the
 * signal, and record it as its own bytes and name say it is
 * (`judgeArrivedSignalFile`), never as its reference stated. Nothing is
 * asked of the seat's machine for a file the signal does not name, from a
 * machine that does not edit the canvas, or when the file would leave this
 * machine's disk under its free floor.
 */
export const pullSignalFile = (deps: SignalFilePullDeps, input: { readonly signal: AgentSignal; readonly ref: ContentRef }): Effect.Effect<void, ContentPullRefused | ContentPullFailed> => {
  const { signal, ref } = input;
  const failed = (message: string) => new ContentPullFailed({ sha256: ref.sha256, byteLength: ref.byteLength, message });
  return Effect.gen(function* () {
    if (!signalFileRefs(signal.attachments).some((named) => named.sha256 === ref.sha256 && named.byteLength === ref.byteLength)) {
      return yield* Effect.fail(failed("the signal attached no such file"));
    }
    const placement = yield* deps.placement(signal.canvasName);
    const home = placement?.seatOf(signal.nodeId)?.machine;
    if (placement === undefined || home === undefined) return yield* Effect.fail(failed("this machine does not hold the seat's canvas"));
    // The seat's own machine holds its files already.
    if (home === deps.self) return;
    if (placement.editor !== deps.self) return yield* Effect.fail(failed("only the machine that edits the canvas pulls a seat's file"));
    const machineName = yield* deps.machineName(home);
    if (machineName === undefined) return yield* Effect.fail(failed("the machine the seat lives on is not set up here"));
    // Before the first piece: the whole file and the store's reserve must fit.
    const room = yield* Effect.try({
      try: () => admitContentWrite({ root: deps.root, needBytes: ref.byteLength, ...(deps.freeBytes === undefined ? {} : { freeBytes: deps.freeBytes }) }),
      catch: () => failed("this machine's free disk could not be read"),
    });
    if (!room.ok) return yield* Effect.fail(failed("the file would leave this machine's disk under its free floor"));
    yield* pullContent({
      root: deps.root,
      ask: (request) => deps.ask(machineName, request),
      keep: (kept, keptOwner) => Effect.gen(function* () {
        const judged = judgeArrivedSignalFile(deps.root, kept, signal);
        if ("refused" in judged) return yield* Effect.fail(failed(judged.refused));
        yield* deps.keep({ ...kept, mediaType: judged.mediaType } as ContentRef, keptOwner);
        yield* deps.judged(signal.signalId, kept, judged.mediaType);
      }),
      ...(deps.once === undefined ? {} : { once: deps.once }),
    }, { ref, owner: signalFileOwner(signal), reached: operatorReachesResource(signal.canvasName, signal.nodeId as NodeId) });
  });
};
