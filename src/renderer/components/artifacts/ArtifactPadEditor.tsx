import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import { MessageSquare } from "lucide-react";
import type { ArtifactPadPatch } from "@shared/artifact";
import { applyPatches, type Pad, type PadPatch } from "@shared/pad";
import { themeMode$ } from "../../lib/theme-mode";
import { PadEditor } from "../pad/PadEditor";
import { PadSvg } from "../pad/PadSvg";
import type { PadCommitOutcome } from "../pad/pad-editor-model";

export type PadCommentBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const PIN_TOOL = '[data-testid="pad-tool-pin"]';

const isPinPatch = (patch: PadPatch): boolean =>
  patch.op === "pin.upsert" || patch.op === "pin.reply";

/** The area a dragged pin covers, or undefined for a bare click. */
const pinArea = (patch: PadPatch): PadCommentBox | undefined => {
  if (patch.op !== "pin.upsert" || patch.pin.bounds === undefined) return undefined;
  const { x, y, bounds } = patch.pin;
  return { x: x - bounds.w / 2, y: y - bounds.h / 2, w: bounds.w, h: bounds.h };
};

/**
 * The artifact pad editor: the pad node's editor over an artifact's pinless
 * pad. Drawing-layer patches go to `onPatch`; a landed write is acked with
 * the pad the patches make, so the editor's revision count and undo hold.
 *
 * An artifact pad holds no pins, so the pin tool is hidden and its drag is
 * turned into "comment on area": the dragged crop goes to `onCommentBox` and
 * the pin itself is never written. PadEditor carries other agents' changes,
 * so this wraps it rather than giving it a pinless mode.
 */
export function ArtifactPadEditor({
  pad,
  readOnly = false,
  onPatch,
  onCommentBox,
}: {
  readonly pad: Pad;
  readonly readOnly?: boolean;
  /** Resolves with the refusal line, or null when the patches landed. */
  readonly onPatch: (patches: ReadonlyArray<ArtifactPadPatch>) => Promise<string | null>;
  readonly onCommentBox?: (box: PadCommentBox) => void;
}) {
  const theme = use$(themeMode$);
  const hostRef = useRef<HTMLDivElement>(null);
  // The pad acks build on: the host's latest, or the last ack made since.
  const ackedRef = useRef(pad);
  const propRef = useRef(pad);
  if (propRef.current !== pad) {
    propRef.current = pad;
    ackedRef.current = pad;
  }
  const commentRef = useRef(onCommentBox);
  useEffect(() => {
    commentRef.current = onCommentBox;
  }, [onCommentBox]);

  // The pin tool stays in the DOM (its key still selects it) but never shows.
  useLayoutEffect(() => {
    const pinTool = hostRef.current?.querySelector<HTMLButtonElement>(PIN_TOOL);
    if (pinTool) pinTool.hidden = true;
  });

  const onCommit = useCallback(
    async (patches: ReadonlyArray<PadPatch>): Promise<PadCommitOutcome> => {
      if (patches.some(isPinPatch)) {
        // `invalid` is refused before anything applied: the editor drops the
        // pin it drew optimistically.
        const area = patches.map(pinArea).find((box) => box !== undefined);
        const comment = commentRef.current;
        if (comment === undefined) {
          return { ok: false, code: "invalid", message: "An artifact pad holds no pins." };
        }
        if (area === undefined) {
          return { ok: false, code: "invalid", message: "Drag to mark the area to comment on." };
        }
        comment(area);
        // Not a write: the pad stays as it was, so the drawn box falls away.
        return { ok: true, pad: ackedRef.current };
      }
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
    <div ref={hostRef} className="pad-surface relative flex h-full min-h-0 flex-col" data-testid="artifact-pad">
      {onCommentBox ? (
        <button
          type="button"
          className="pad-tool absolute right-2 top-1.5 z-10"
          data-testid="artifact-pad-comment"
          aria-label="Comment on an area (P)"
          title="Comment on an area (P): drag a box"
          onClick={() => hostRef.current?.querySelector<HTMLButtonElement>(PIN_TOOL)?.click()}
        >
          <MessageSquare size={13} />
        </button>
      ) : null}
      <PadEditor
        pad={pad}
        // No pad node behind an artifact pad, so no pin mention candidates.
        padNodeId=""
        onCommit={onCommit}
        onReadPad={onReadPad}
        onClose={onClose}
      />
    </div>
  );
}
