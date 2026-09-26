import { useEffect, useLayoutEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { Pin, PinOff, X } from "lucide-react";

import {
  markdownImageLine,
  putImagesFromDataTransfer,
} from "../../lib/image-content";
import { registerCanvasDraftCommit } from "../../lib/canvas-editor-flush";
import {
  closeWorkbenchSurface,
  dock$,
  markNoteSurfaceSaved,
  pinWorkbenchSurface,
  unpinWorkbenchSurface,
  updateNoteSurfaceDraft,
} from "../../lib/dock-state";
import { editText } from "../../lib/mutations";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";
import { state$ } from "../../lib/state";
import type { WorkSurface, WorkZone } from "../../lib/surface-registry";
import { Button, IconButton, Kbd, OverlayHeader } from "../ui";
import { isMac } from "../../lib/platform";
import { claimFocus } from "../../lib/focus-ownership";

/** Save the latest Note draft without changing focus or closing its surface. */
export const saveNoteSurfaceDraft = (surfaceId: string): void => {
  const payload = dock$.noteById[surfaceId].peek();
  if (!payload || payload.draft === payload.savedText) return;
  const node = state$.doc.nodes
    .peek()
    .find((candidate) => candidate.id === payload.nodeId);
  if (!node || node.type !== "text" || node.ether?.entity) return;
  editText(payload.nodeId, payload.draft);
  markNoteSurfaceSaved(surfaceId, payload.draft);
};

/** Modal/backdrop semantics: save the current draft, then dismiss the view. */
export const saveAndCloseNoteSurface = (surfaceId: string): void => {
  saveNoteSurfaceDraft(surfaceId);
  closeWorkbenchSurface(surfaceId);
};

/** Explicit X/Escape semantics: discard edits since the last durability save. */
export const discardAndCloseNoteSurface = (surfaceId: string): void => {
  closeWorkbenchSurface(surfaceId);
};

export function NoteSurface({
  surface,
  zone,
  visible,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly zone: WorkZone;
  readonly visible: boolean;
  readonly onActivate: () => void;
}) {
  const payload = use$(dock$.noteById[surface.id]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(
    () => registerCanvasDraftCommit(() => saveNoteSurfaceDraft(surface.id)),
    [surface.id],
  );

  useEffect(() => {
    if (!visible || zone !== "focus") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        discardAndCloseNoteSurface(surface.id);
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        saveAndCloseNoteSurface(surface.id);
      }
    };
    // focus-law: Escape and Cmd+Enter are this note's own commands.
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface.id, visible, zone]);

  if (!payload) {
    return (
      <section className="dock-slot workbench-surface">
        <div className="workbench-surface__placeholder">note - unbound</div>
      </section>
    );
  }

  const pinned = zone === "pinned";

  const insertAtCursor = (snippet: string): void => {
    const element = textareaRef.current;
    const current = element?.value ?? payload.draft;
    if (!element) {
      updateNoteSurfaceDraft(
        surface.id,
        current.endsWith("\n") || current.length === 0
          ? `${current}${snippet}`
          : `${current}\n${snippet}`,
      );
      return;
    }
    const start = element.selectionStart;
    const end = element.selectionEnd;
    updateNoteSurfaceDraft(
      surface.id,
      `${current.slice(0, start)}${snippet}${current.slice(end)}`,
    );
    requestAnimationFrame(() => {
      const caret = start + snippet.length;
      if (claimFocus(element, "gesture")) element.setSelectionRange(caret, caret);
    });
  };

  const onPasteImage = (
    event: React.ClipboardEvent<HTMLTextAreaElement>,
  ): void => {
    const data = event.clipboardData;
    const hasImageItem =
      Array.from(data.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      ) ||
      Array.from(data.files ?? []).some((file) =>
        file.type.startsWith("image/"),
      );
    if (!hasImageItem) return;
    event.preventDefault();
    void (async () => {
      const result = await putImagesFromDataTransfer(data);
      if (result.kind === "none") return;
      if (result.kind === "error") {
        state$.error.set(result.error);
        return;
      }
      const lines = result.refs.map((ref) =>
        markdownImageLine(ref, ref.displayName ?? "image"),
      );
      insertAtCursor(`${lines.join("\n")}\n`);
    })();
  };

  return (
    <section
      className="dock-slot dock-slot--note workbench-surface"
      aria-label={`Edit note - ${payload.title}`}
      aria-hidden={!visible}
      data-focus-owner="interactive"
      data-testid="note-workbench-surface"
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      <div className="note-edit-modal nowheel">
        <OverlayHeader
          eyebrow="note"
          title={<span title={payload.title}>{payload.title.replace(/^#+\s*/, "") || "untitled"}</span>}
          actions={
            <>
              <IconButton
                size="sm"
                aria-label={pinned ? "Unpin note editor" : "Pin note editor"}
                title={pinned ? "Move to focus" : "Pin to side dock"}
                onClick={() => {
                  if (pinned) unpinWorkbenchSurface(surface.id);
                  else pinWorkbenchSurface(surface.id);
                }}
              >
                {pinned ? <PinOff size={13} /> : <Pin size={13} />}
              </IconButton>
              <Button
                size="xs"
                variant="chrome"
                onClick={() => saveAndCloseNoteSurface(surface.id)}
              >
                done
              </Button>
              <IconButton
                size="sm"
                aria-label="Close without saving"
                title="Discard"
                onClick={() => discardAndCloseNoteSurface(surface.id)}
              >
                <X size={13} />
              </IconButton>
            </>
          }
        />
        <textarea
          ref={textareaRef}
          data-autofocus
          className="note-edit-modal__textarea nodrag nowheel"
          aria-label="Note markdown"
          spellCheck
          value={payload.draft}
          onChange={(event) =>
            updateNoteSurfaceDraft(surface.id, event.target.value)
          }
          onPaste={onPasteImage}
          placeholder={
            "# heading\n\n- list item\n\n**bold** and `code`\n\npaste an image to embed"
          }
        />
        <footer className="note-edit-modal__hint">
          <span>
            <Kbd>{isMac() ? "⌘ ↵" : "ctrl ↵"}</Kbd> save
          </span>
          <span>
            <Kbd>esc</Kbd> discard
          </span>
          <span>paste an image to embed it</span>
        </footer>
      </div>
    </section>
  );
}
