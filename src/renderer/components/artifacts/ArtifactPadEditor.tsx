import { useCallback, useMemo, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import type { ArtifactPadPatch } from "@shared/artifact";
import type { MentionCandidate } from "../../lib/mention-draft";
import { applyPatches, type Pad, type PadPatch } from "@shared/pad";
import { themeMode$ } from "../../lib/theme-mode";
import { PadEditor, type PadArea, type PadPins } from "../pad/PadEditor";
import { PadSvg } from "../pad/PadSvg";
import type { PadCommitOutcome } from "../pad/pad-editor-model";

export type PadCommentBox = PadArea;

/**
 * The artifact pad editor: the pad node's editor over an artifact's pinless
 * pad. Drawing-layer patches go to `onPatch`; a landed write is acked with
 * the pad the patches make, so the editor's revision count and undo hold.
 *
 * An artifact pad holds no pins: with `onCommentBox` the P tool picks an
 * area to comment on and writes nothing, and without it there is no P tool.
 * `mentions` are what @ offers to put on the pad as a live card.
 */
export function ArtifactPadEditor({
  pad,
  readOnly = false,
  onPatch,
  onCommentBox,
  mentions,
}: {
  readonly pad: Pad;
  readonly readOnly?: boolean;
  /** Resolves with the refusal line, or null when the patches landed. */
  readonly onPatch: (patches: ReadonlyArray<ArtifactPadPatch>) => Promise<string | null>;
  readonly onCommentBox?: (box: PadCommentBox) => void;
  /** The seats, tasks and artifacts in reach, as the document's @ offers them. */
  readonly mentions?: { readonly candidates: ReadonlyArray<MentionCandidate> };
}) {
  const theme = use$(themeMode$);
  // The pad acks build on: the host's latest, or the last ack made since.
  const ackedRef = useRef(pad);
  const propRef = useRef(pad);
  if (propRef.current !== pad) {
    propRef.current = pad;
    ackedRef.current = pad;
  }
  const pins = useMemo<PadPins>(
    () => (onCommentBox ? { kind: "area", onArea: onCommentBox } : { kind: "none" }),
    [onCommentBox],
  );

  const onCommit = useCallback(
    async (patches: ReadonlyArray<PadPatch>): Promise<PadCommitOutcome> => {
      // No pin mode writes a pin, so every patch here is the drawing layer.
      const drawing = patches as ReadonlyArray<ArtifactPadPatch>;
      const next = applyPatches(ackedRef.current, drawing);
      if (Result.isFailure(next)) {
        return { ok: false, code: "invalid", message: next.failure.message };
      }
      const refusal = await onPatch(drawing).catch((error: unknown) =>
        error instanceof Error ? error.message : "The pad could not be written.",
      );
      if (refusal !== null) return { ok: false, message: refusal };
      ackedRef.current = next.success;
      return { ok: true, pad: next.success };
    },
    [onPatch],
  );

  const onReadPad = useCallback(async (): Promise<Pad | null> => ackedRef.current, []);
  // The artifacts pane owns closing; Escape in the editor only clears.
  const onClose = useCallback(() => {}, []);

  if (readOnly) {
    return (
      <div className="pad-surface flex h-full min-h-0 items-center justify-center" data-testid="artifact-pad" data-readonly="true">
        <PadSvg pad={pad} theme={theme} options={{ framed: true }} />
      </div>
    );
  }

  return (
    <div className="pad-surface relative flex h-full min-h-0 flex-col" data-testid="artifact-pad">
      <PadEditor
        pad={pad}
        pins={pins}
        onCommit={onCommit}
        onReadPad={onReadPad}
        onClose={onClose}
        {...(mentions === undefined ? {} : { cards: { candidates: mentions.candidates } })}
      />
    </div>
  );
}
