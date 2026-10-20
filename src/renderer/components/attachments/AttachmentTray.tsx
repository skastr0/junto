import { useRef } from "react";
import { AlertTriangle, File as FileGlyph, LoaderCircle, Paperclip, X } from "lucide-react";
import { OPERATOR_ATTACHMENTS_MAX, attachmentSizeLabel } from "@shared/operator-attachments";
import type { AttachmentItem, Attachments } from "../../lib/operator-attachments";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

/**
 * The operator's files on a mail being written, one component for every
 * composer (a thread mail, a signal answer). `AttachButton` picks files;
 * `AttachmentTray` shows each as a chip: an image as its thumbnail, anything
 * else as a file, with its size, its upload state and a remove. Paste and
 * drop are the composer's own, through `useAttachments(...).dropTarget`.
 */

/** Pick files from disk. Hidden while the mail is full. */
export function AttachButton({
  attachments,
  disabled = false,
}: {
  readonly attachments: Attachments;
  readonly disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const full = attachments.items.length >= OPERATOR_ATTACHMENTS_MAX;
  return (
    <>
      <Button
        size="xs"
        variant="subtle"
        disabled={disabled || full}
        title={full ? `A mail carries at most ${OPERATOR_ATTACHMENTS_MAX} files` : "Attach files, or paste or drop them here"}
        onClick={() => inputRef.current?.click()}
        data-testid="attach-files"
      >
        <Paperclip size={11} aria-hidden />
        Attach
      </Button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="attach-files-input"
        onChange={(event) => {
          attachments.add([...(event.currentTarget.files ?? [])]);
          // The same file can be picked again after a remove.
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}

const extensionOf = (name: string): string | undefined => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).slice(0, 5).toUpperCase() : undefined;
};

function AttachmentChip({ item, onRemove }: { readonly item: AttachmentItem; readonly onRemove: () => void }) {
  const failed = item.state === "failed";
  return (
    <li
      className={[
        "flex max-w-56 items-center gap-2 rounded-md border py-1 pl-1 pr-1.5",
        failed ? "border-crimson/40 bg-crimson/[0.06]" : "border-stroke bg-ink/[0.04]",
      ].join(" ")}
      data-testid="attachment-chip"
      data-state={item.state}
    >
      <span className="relative grid size-9 flex-none place-items-center overflow-hidden rounded bg-ink/[0.06] text-dim">
        {item.previewUrl ? (
          <img src={item.previewUrl} alt="" className="size-full object-cover" draggable={false} />
        ) : (
          <span className="flex flex-col items-center gap-0.5">
            <FileGlyph size={14} aria-hidden />
            {extensionOf(item.name) ? <span className="text-micro leading-none">{extensionOf(item.name)}</span> : null}
          </span>
        )}
        {item.state === "uploading" ? (
          <span className="absolute inset-0 grid place-items-center bg-ground/60">
            <LoaderCircle size={14} className="animate-spin" aria-hidden />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-caption text-ink" title={item.name}>
          {item.name}
        </span>
        <span className={["truncate text-micro", failed ? "text-crimson-fg" : "text-dim"].join(" ")} title={item.error}>
          {failed ? (
            <>
              <AlertTriangle size={10} className="mr-1 inline align-[-1px]" aria-hidden />
              {item.error ?? "Not attached"}
            </>
          ) : item.state === "uploading" ? (
            `Attaching, ${attachmentSizeLabel(item.byteLength)}`
          ) : (
            attachmentSizeLabel(item.byteLength)
          )}
        </span>
      </span>
      <IconButton size="xs" tone="danger" aria-label={`Remove ${item.name}`} title={`Remove ${item.name}`} onClick={onRemove}>
        <X size={11} aria-hidden />
      </IconButton>
    </li>
  );
}

/** The files on the mail, and why one was not taken. Nothing when there are none. */
export function AttachmentTray({ attachments }: { readonly attachments: Attachments }) {
  const { items, notice } = attachments;
  if (items.length === 0 && notice === undefined) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="attachment-tray">
      {items.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${items.length} ${items.length === 1 ? "file" : "files"} attached`}>
          {items.map((item) => (
            <AttachmentChip key={item.id} item={item} onRemove={() => attachments.remove(item.id)} />
          ))}
        </ul>
      ) : null}
      {notice ? (
        <p className="text-caption text-crimson-fg" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
