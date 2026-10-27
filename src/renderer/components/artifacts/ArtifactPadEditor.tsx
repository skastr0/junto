import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import type { ArtifactPadPatch } from "@shared/artifact";
import { applyPatches, type Pad, type PadPatch } from "@shared/pad";
import { DEV_TOOLS_ENABLED } from "@shared/features";
import { themeMode$ } from "../../lib/theme-mode";
import { padEngine$ } from "../../lib/pad-engine";
import { Button } from "../ui";
import { PadEditor, type PadArea, type PadPins } from "../pad/PadEditor";
import { PadSvg } from "../pad/PadSvg";
import type { PadCommitOutcome } from "../pad/pad-editor-model";

export type PadCommentBox = PadArea;

/** The Excalidraw pad (spike): its own chunk, loaded only when picked, never in a ship build. */
const ExcalidrawPad = DEV_TOOLS_ENABLED
  ? lazy(() => import("../pad/excalidraw/ExcalidrawPad").then((module) => ({ default: module.ExcalidrawPad })))
  : null;

/** Dev builds: switch the engine that draws the pad. */
function PadEngineSwitch() {
  const engine = use$(padEngine$);
  return (
    <div className="artifact-pad-engine" role="radiogroup" aria-label="Pad engine">
      {(["svg", "excalidraw"] as const).map((option) => (
        <Button
          key={option}
          size="xs"
          variant={engine === option ? "chrome" : "subtle"}
          role="radio"
          aria-checked={engine === option}
          data-testid={`pad-engine-${option}`}
          onClick={() => padEngine$.set(option)}
        >
          {option === "svg" ? "SVG" : "Excalidraw"}
        </Button>
      ))}
    </div>
  );
}

/**
 * The artifact pad editor: the pad node's editor over an artifact's pinless
 * pad. Drawing-layer patches go to `onPatch`; a landed write is acked with
 * the pad the patches make, so the editor's revision count and undo hold.
 *
 * An artifact pad holds no pins: with `onCommentBox` the P tool picks an
 * area to comment on and writes nothing, and without it there is no P tool.
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
  const engine = use$(padEngine$);
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

  if (ExcalidrawPad && engine === "excalidraw") {
    return (
      <div className="pad-surface relative flex h-full min-h-0 flex-col" data-testid="artifact-pad" data-engine="excalidraw">
        <PadEngineSwitch />
        <Suspense fallback={null}>
          <ExcalidrawPad pad={pad} onCommit={onCommit} {...(onCommentBox ? { onCommentBox } : {})} />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="pad-surface relative flex h-full min-h-0 flex-col" data-testid="artifact-pad">
      {DEV_TOOLS_ENABLED ? <PadEngineSwitch /> : null}
      <PadEditor
        pad={pad}
        pins={pins}
        onCommit={onCommit}
        onReadPad={onReadPad}
        onClose={onClose}
      />
    </div>
  );
}
