/**
 * Whether this machine serves a signal's file to the asking machine (plan
 * 02, signal attachments as refs). The file lives where the seat lives, and
 * the raise that names it crosses to one machine only, the one that edits
 * the canvas (`signalStatedTo`). So the file is served by the same rule as
 * its row: this machine is the seat's machine now, the asker edits the canvas
 * now, and the signal is held here, open, and names these bytes. Each of
 * those is read from this machine's store and placement, never from the
 * request. A closed signal lets go of its files, so it serves nothing.
 */
import { Effect, Option } from "effect";
import type { InstallationId } from "@shared/installation-id";
import type { CanvasPlacement } from "@shared/work-exchange";
import type { AgentSignalRepository } from "../signals/repository";
import { signalFileRefs } from "../signals/taken-attachments";

export type SignalFileOwner = { readonly canvasName: string; readonly nodeId: string; readonly recordId: string };

export const signalFileEntitled = (
  signals: AgentSignalRepository["Service"],
  input: {
    /** The signal owner the store holds the file under: the signal's id. */
    readonly owner: SignalFileOwner;
    readonly sha256: string;
    /** The asking machine. */
    readonly machine: InstallationId;
    /** This machine. */
    readonly self: InstallationId;
    /** The canvas's placement now: a seat that left this machine serves nothing from it. */
    readonly placement: CanvasPlacement;
  },
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const { owner, sha256, machine, self, placement } = input;
    if (placement.editor !== machine || placement.editor === self) return false;
    if (placement.seatOf(owner.nodeId)?.machine !== self) return false;
    const held = yield* signals.get(owner.recordId).pipe(Effect.option);
    if (Option.isNone(held)) return false;
    const signal = held.value;
    return (
      signal.canvasName === owner.canvasName &&
      signal.nodeId === owner.nodeId &&
      signal.state === "open" &&
      signalFileRefs(signal.attachments).some((ref) => ref.sha256 === sha256)
    );
  });
