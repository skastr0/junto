import { defaultTemperament } from "@shared/agent-portrait";
import { portraitExpression, type ExpressionInput, type PortraitExpression } from "@shared/portrait-expression";
import { AgentPortrait } from "../AgentPortrait";
import { Button } from "../ui";
import { useCharacterDraft } from "./character-draft";
import type { AgentEditorSectionProps } from "./sections";

// Mood: temperament shifts how the seat's face reads its state (working,
// stuck, done). The strip shows those states live as the slider moves.

const MOOD_STRIP: ReadonlyArray<readonly [string, Omit<ExpressionInput, "temperament">]> = [
  ["idle", { activity: "rest" }],
  ["working", { activity: "work" }],
  ["going well", { activity: "work", health: "succeeding" }],
  ["wants you", { activity: "call" }],
  ["stuck", { activity: "work", health: "stuck" }],
  ["done", { activity: "done" }],
];

export const temperamentWord = (value: number): string =>
  value <= -0.34 ? "moody" : value >= 0.34 ? "cheerful" : "even";

export function MoodSection({ seat }: AgentEditorSectionProps) {
  const { identity, draft, character, set } = useCharacterDraft();
  const faceFor = (mood: Omit<ExpressionInput, "temperament">): PortraitExpression =>
    portraitExpression({ ...mood, temperament: character.temperament });
  const born = defaultTemperament(identity);

  return (
    <div className="agent-editor__mood">
      <label className="agent-editor__temperament">
        <span className="agent-editor__temperament-head">
          <span>temperament</span>
          <span className="text-ink">{temperamentWord(character.temperament)}</span>
        </span>
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={character.temperament}
          aria-label="Temperament, moody to cheerful"
          onChange={(event) => set("temperament", Number(event.target.value))}
        />
        <span className="agent-editor__temperament-ends">
          <span>moody</span>
          <span>cheerful</span>
        </span>
      </label>

      <div className="agent-editor__moods" aria-label={`How ${seat.name} reads seat states`}>
        {MOOD_STRIP.map(([label, mood]) => (
          <figure key={label}>
            <AgentPortrait identity={identity} size={44} frame="round" config={draft} expression={faceFor(mood)} />
            <figcaption>{label}</figcaption>
          </figure>
        ))}
      </div>

      <div className="agent-editor__row">
        <span className="agent-editor__hint">
          Born {temperamentWord(born)}. The face follows the seat: working, waiting on you, stuck, done.
        </span>
        <Button
          size="xs"
          variant="subtle"
          disabled={draft.temperament === undefined}
          title={`Back to the temperament ${seat.name} was born with`}
          onClick={() => set("temperament", undefined)}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
