import { X } from "lucide-react";
import { IconButton } from "@renderer/components/ui/IconButton";
import type { FilesDrop } from "./useFilesDrop";
import "./files-drop.css";

/**
 * What a drop on the Files modal shows, drawn inside the surface the hook
 * is spread on: the folder row a Finder drag is over, marked with the house
 * drop edge (the whole surface takes that edge when the drop goes to the
 * root), a line naming the folder the copy lands in, and the outcome once
 * it is done.
 */
export function FilesDropHighlight({ drop }: { readonly drop: FilesDrop }) {
  const { target, notice } = drop;
  return (
    <>
      {target?.rect != null && (
        <div
          aria-hidden="true"
          className="files-drop__row"
          style={{
            top: target.rect.top,
            left: target.rect.left,
            width: target.rect.width,
            height: target.rect.height,
          }}
        />
      )}
      {target !== null && (
        <div aria-hidden="true" className="files-drop__caption">
          Copy into {target.label}
        </div>
      )}
      {target === null && notice !== undefined && (
        <div
          role={notice.failed ? "alert" : "status"}
          className="files-drop__notice"
          data-failed={notice.failed ? "true" : undefined}
        >
          <span className="files-drop__notice-text">{notice.text}</span>
          <IconButton size="xs" aria-label="Dismiss" title="Dismiss" onClick={drop.dismissNotice}>
            <X size={12} aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </>
  );
}

/**
 * The tree's own drop target, for a row dragged inside it, in the same drop
 * edge and wash. Pass as the tree's `unsafeCSS`: its rows live in a shadow root, and
 * only custom properties cross it, so the rule has to be inside.
 */
export const FILES_DROP_TREE_CSS = `
  [data-item-drag-target="true"] {
    outline: 1px dashed var(--color-cyan);
    outline-offset: -1px;
    background: color-mix(in oklab, var(--color-cyan) 10%, transparent);
  }
`;
