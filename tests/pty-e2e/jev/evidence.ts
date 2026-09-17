/**
 * The frozen evidence window.
 *
 * Contract (from the seat-awareness ADR): the bottom bounded window of the
 * headless grid, each line id-tagged `L000| text`, capped at 128 candidate
 * lines. Ids are POSITIONAL WITHIN THE WINDOW (`L000` is the first retained
 * line, not a grid row number), which is what makes a `highlight_line` Choice
 * answer checkable against the same window the model saw.
 */

export const MAX_CANDIDATE_LINES = 128;

export type IdLines = {
  /** `L000| text` — the id is what a Choice answer can point at. */
  readonly text: string;
  readonly ids: readonly string[];
  /** The untagged window lines, in window order. */
  readonly lines: readonly string[];
};

export const idLines = (screen: string, limit = MAX_CANDIDATE_LINES): IdLines => {
  const lines = screen.split("\n").slice(-limit);
  const ids = lines.map((_, i) => `L${String(i).padStart(3, "0")}`);
  return {
    text: lines.map((line, i) => `${ids[i]}| ${line}`).join("\n"),
    ids,
    lines,
  };
};

/** The window offered for one observation, plus its id range. */
export const windowFor = (screen: string): IdLines => idLines(screen);
