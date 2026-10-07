/**
 * What the Briefing and References pages share: bringing a text file into an
 * editor, and holding an edit against a text that someone else may change
 * while it is open (an overseer may write both).
 */
import { useRef, type ReactNode } from "react";
import { FileUp } from "lucide-react";
import { Button } from "../ui";

/** Reads one text file the operator picks and hands over its name and text. */
export function ImportFileButton({
  label = "Import a file",
  disabled = false,
  onImport,
}: {
  readonly label?: string;
  readonly disabled?: boolean;
  readonly onImport: (file: { readonly name: string; readonly text: string }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        hidden
        tabIndex={-1}
        aria-hidden
        data-testid="text-import-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // The same file can be picked twice in a row.
          event.target.value = "";
          if (!file) return;
          void file.text().then((text) => onImport({ name: file.name, text }));
        }}
      />
      <Button variant="chrome" size="md" disabled={disabled} onClick={() => inputRef.current?.click()}>
        <FileUp size={13} aria-hidden />
        {label}
      </Button>
    </>
  );
}

/** Text brought in lands after what is already written, a blank line between. */
export const appendText = (current: string, incoming: string): string => {
  const base = current.replace(/\s+$/, "");
  const next = incoming.replace(/^\s+/, "");
  return base.length === 0 ? next : `${base}\n\n${next}`;
};

/**
 * Shown when the stored text changed while an edit was open. Nothing is
 * overwritten until the operator picks one.
 */
export function ChangedElsewhere({
  what,
  onTakeTheirs,
  onKeepMine,
}: {
  readonly what: string;
  readonly onTakeTheirs: () => void;
  readonly onKeepMine: () => void;
}): ReactNode {
  return (
    <div className="texts-settings__changed" role="alert" data-testid="text-changed-elsewhere">
      <span>{what} was changed while you were editing.</span>
      <Button size="sm" variant="chrome" onClick={onTakeTheirs}>
        Load the new text
      </Button>
      <Button size="sm" variant="subtle" onClick={onKeepMine}>
        Keep mine
      </Button>
    </div>
  );
}

/** "1.2 kB", "340 B": how much text a reference holds. */
export const textSize = (bytes: number): string =>
  bytes < 1_000 ? `${String(bytes)} B` : `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} kB`;
