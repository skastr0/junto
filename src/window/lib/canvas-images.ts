/**
 * Images dropped or pasted onto the field: one content-store image per file,
 * laid down in a short diagonal from the point the operator meant.
 *
 * The board point comes from the canvas that is drawing (React Flow's
 * `screenToFlowPosition`, or the GPU canvas's `screenToBoard`), so the same
 * gesture lands under the pointer on either canvas and no canvas owns the
 * authoring: this hook does, once.
 */
import { useCallback } from "react";
import { contentObjectUrl } from "@shared/content-url";
import { useContentCalls } from "./content-calls";
import { putImagesFromDataTransfer } from "./image-content";
import { newImage } from "./model-factories";
import { addNode, onTop } from "./mutations";
import { state$ } from "./state";

export type ImagePlacement = (
  data: DataTransfer | null | undefined,
  at: { readonly x: number; readonly y: number },
) => Promise<boolean>;

/** Place what a drop or a paste carried. True when the data held any images. */
export const useImagePlacement = (): ImagePlacement => {
  const content = useContentCalls();
  return useCallback(
    async (data, at) => {
      const result = await putImagesFromDataTransfer(content, data);
      if (result.kind === "none") return false;
      if (result.kind === "error") {
        state$.error.set(result.error);
        return true;
      }
      let offset = 0;
      for (const ref of result.refs) {
        const node = newImage(
          onTop({ x: at.x + offset, y: at.y + offset }),
          contentObjectUrl(ref),
        );
        addNode(node, { edit: false });
        state$.focusNodeId.set(node.id);
        offset += 24;
      }
      return true;
    },
    [content],
  );
};

/** The board point a drop at a screen point means, a card's own top-left. */
export const dropPoint = (at: { readonly x: number; readonly y: number }) => ({
  x: at.x - 140,
  y: at.y - 100,
});

/** True when a clipboard payload carries an image file. */
export const clipboardHasImage = (data: DataTransfer): boolean =>
  Array.from(data.items ?? []).some(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  ) || Array.from(data.files ?? []).some((file) => file.type.startsWith("image/"));

/** The screen point a paste lands at: the middle of the field, whichever canvas draws it. */
export const pastePoint = (): { readonly x: number; readonly y: number } => {
  const field = document.querySelector(".junto-stage-main");
  const rect = field?.getBoundingClientRect();
  if (rect === undefined || rect.width === 0 || rect.height === 0) {
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
