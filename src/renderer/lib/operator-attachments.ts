import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { CONTENT_STAGE_PIECE_BYTES } from "@shared/content-stage";
import {
  OPERATOR_ATTACHMENT_MAX_BYTES,
  OPERATOR_ATTACHMENTS_MAX,
  isThumbnailType,
  type OperatorContentPut,
  type OperatorContentPutResult,
} from "@shared/operator-attachments";
import { attachmentName } from "@shared/preview-bytes";
import type { ContentRef } from "@shared/wire/content-ref";

/**
 * Files the operator attaches to a mail from the desktop: a thread mail or a
 * signal answer. Each file is uploaded into the Mac content store the moment
 * it is added (pasted, dropped or picked), in pieces, and the composer sends
 * the refs once every file is in. Junto never opens what is attached: an
 * image is drawn from the operator's own file as a thumbnail, nothing else.
 */

export type AttachmentState = "uploading" | "ready" | "failed";

export type AttachmentItem = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly state: AttachmentState;
  /** The file's own pixels, for an image a thumbnail can draw. */
  readonly previewUrl?: string;
  readonly ref?: ContentRef;
  readonly error?: string;
};

/** One piece to main; absent when the app has no upload channel (a test, a browser). */
export type OperatorContentPutter = (input: OperatorContentPut) => Promise<OperatorContentPutResult>;

const junto = (): { operatorContentPut?: OperatorContentPutter } | undefined =>
  (window as { junto?: { operatorContentPut?: OperatorContentPutter } }).junto;

let putter: OperatorContentPutter | undefined;

/** Tests hand in their own upload; undefined goes back to main's. */
export const setOperatorContentPutter = (next: OperatorContentPutter | undefined): void => {
  putter = next;
};

const activePutter = (): OperatorContentPutter | undefined => putter ?? junto()?.operatorContentPut;

const MAX_MB = OPERATOR_ATTACHMENT_MAX_BYTES / (1024 * 1024);

/** Standard Base64 of a blob, read natively rather than byte by byte. */
const base64Of = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("the file could not be read"));
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });

/**
 * Upload one file in pieces as the operator, for a mail on `canvasName`.
 * Answers its ref, or throws with main's words.
 */
export const uploadOperatorFile = async (
  put: OperatorContentPutter,
  canvasName: string,
  file: Blob,
  meta: { readonly name: string; readonly mediaType: string },
): Promise<ContentRef> => {
  let stageId: string | undefined;
  let offset = 0;
  for (;;) {
    const end = Math.min(file.size, offset + CONTENT_STAGE_PIECE_BYTES);
    const last = end >= file.size;
    const bytesBase64 = await base64Of(file.slice(offset, end));
    const answer = await put({
      canvasName,
      stage: {
        ...(stageId === undefined ? {} : { stageId }),
        bytesBase64,
        ...(last ? { done: { mediaType: meta.mediaType, displayName: meta.name } } : {}),
      },
    } as OperatorContentPut);
    if (!answer.ok) throw new Error(answer.message);
    if ("ref" in answer.result) return answer.result.ref;
    stageId = answer.result.stageId;
    offset = end;
    if (last) throw new Error("The file could not be stored.");
  }
};

/** What a composer holds and hands its tray. */
export type Attachments = {
  readonly items: ReadonlyArray<AttachmentItem>;
  /** Every file's ref once all are in; undefined while one is uploading or failed. */
  readonly ready: ReadonlyArray<ContentRef> | undefined;
  /** A file the tray would not take (too many, too large), in words. */
  readonly notice: string | undefined;
  /** A file is being dragged over the composer. */
  readonly dragging: boolean;
  readonly add: (files: ReadonlyArray<File>) => void;
  readonly remove: (id: string) => void;
  /** After a send: empty the tray. */
  readonly clear: () => void;
  /** Spread on the composer: paste and drop add files. */
  readonly dropTarget: {
    readonly onPaste: (event: ClipboardEvent) => void;
    readonly onDragEnter: (event: DragEvent) => void;
    readonly onDragOver: (event: DragEvent) => void;
    readonly onDragLeave: (event: DragEvent) => void;
    readonly onDrop: (event: DragEvent) => void;
    /** Marks the drop target, so the tray's drop edge lands on it alone. */
    readonly "data-attach-drop": "true";
    readonly "data-dragging"?: "true";
  };
};

const hasFiles = (event: DragEvent): boolean => [...(event.dataTransfer?.types ?? [])].includes("Files");

let nextId = 0;

/**
 * The tray's files for one composer: add uploads at once, remove and clear
 * let go of the thumbnails. A file past the count or the size is refused
 * with a notice and never uploaded.
 */
export const useAttachments = (canvasName: string): Attachments => {
  const [items, setItems] = useState<ReadonlyArray<AttachmentItem>>([]);
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // Ids still in the tray: an upload that ends after its file was removed is dropped.
  const live = useRef(new Set<string>());

  const patch = useCallback((id: string, change: Partial<AttachmentItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const add = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      const room = OPERATOR_ATTACHMENTS_MAX - itemsRef.current.length;
      const refused: string[] = [];
      if (files.length > room) refused.push(`A mail carries at most ${OPERATOR_ATTACHMENTS_MAX} files.`);
      const taken = files.slice(0, Math.max(0, room)).filter((file) => {
        if (file.size <= OPERATOR_ATTACHMENT_MAX_BYTES) return true;
        refused.push(`${attachmentName(file.name) || "A file"} is over ${MAX_MB} MB.`);
        return false;
      });
      setNotice(refused.length > 0 ? refused.join(" ") : undefined);
      const put = activePutter();
      const added = taken.map((file): { item: AttachmentItem; file: File } => {
        const name = attachmentName(file.name) || "file";
        const mediaType = file.type || "application/octet-stream";
        nextId += 1;
        return {
          file,
          item: {
            id: `attachment-${nextId}`,
            name,
            mediaType,
            byteLength: file.size,
            state: put ? "uploading" : "failed",
            ...(isThumbnailType(mediaType) ? { previewUrl: URL.createObjectURL(file) } : {}),
            ...(put ? {} : { error: "Attaching files is not available here." }),
          },
        };
      });
      for (const { item } of added) live.current.add(item.id);
      setItems((current) => [...current, ...added.map(({ item }) => item)]);
      if (!put) return;
      for (const { item, file } of added) {
        uploadOperatorFile(put, canvasName, file, item).then(
          (ref) => {
            if (live.current.has(item.id)) patch(item.id, { state: "ready", ref });
          },
          (error: unknown) => {
            if (!live.current.has(item.id)) return;
            patch(item.id, { state: "failed", error: error instanceof Error ? error.message : "The file could not be attached." });
          },
        );
      }
    },
    [canvasName, patch],
  );

  const remove = useCallback((id: string) => {
    live.current.delete(id);
    const gone = itemsRef.current.find((item) => item.id === id);
    if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
    setItems((current) => current.filter((item) => item.id !== id));
    setNotice(undefined);
  }, []);

  const clear = useCallback(() => {
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    live.current.clear();
    setItems([]);
    setNotice(undefined);
  }, []);

  // The thumbnails let go with the composer.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      live.current.clear();
    },
    [],
  );

  const ready = items.every((item) => item.state === "ready" && item.ref !== undefined)
    ? items.map((item) => item.ref!)
    : undefined;

  return {
    items,
    ready,
    notice,
    dragging,
    add,
    remove,
    clear,
    dropTarget: {
      onPaste: (event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length === 0) return;
        // Pasted files attach; pasted text still types.
        event.preventDefault();
        add(files);
      },
      onDragEnter: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      },
      onDragOver: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event) => {
        // Leaving for a child is not leaving the composer.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      },
      onDrop: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        add([...(event.dataTransfer?.files ?? [])]);
      },
      "data-attach-drop": "true",
      ...(dragging ? { "data-dragging": "true" as const } : {}),
    },
  };
};
