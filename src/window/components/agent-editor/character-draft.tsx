import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { portraitCharacter, type PortraitCharacter, type PortraitConfig } from "@shared/agent-portrait";
import type { PortraitExpression } from "@shared/portrait-expression";
import { savePortraitOverride } from "../../lib/portrait-overrides-state";
import { usePortraitConfig } from "../AgentPortrait";
import type { AgentEditorDraft } from "./sections";

// The seat's character override while the editor is open, shared by the hero
// preview and the Look and Mood sections. Edits save as they happen
// (debounced), so the seat on the canvas changes with the editor; an empty
// override drops back to the character the seat was born with. Hovering an
// option or a mood previews it on the stage without saving anything.

const SAVE_DEBOUNCE_MS = 220;

export interface CharacterDraft {
  readonly identity: string;
  readonly draft: PortraitConfig;
  /** The draft resolved against the seat's identity: what is on screen. */
  readonly character: PortraitCharacter;
  readonly saveFailed: boolean;
  readonly set: <K extends keyof PortraitConfig>(key: K, value: PortraitConfig[K]) => void;
  /** Replace the whole override; `{}` is the born character. */
  readonly replace: (next: PortraitConfig) => void;
  /** What the stage shows while an option or mood is hovered. */
  readonly preview: CharacterPreview | undefined;
  readonly setPreview: (preview: CharacterPreview | undefined) => void;
}

export interface CharacterPreview {
  /** The draft with the hovered option applied. */
  readonly config?: PortraitConfig;
  readonly expression?: PortraitExpression;
  /** What is being previewed, for the stage caption. */
  readonly label: string;
}

export const isEmptyConfig = (config: PortraitConfig): boolean =>
  Object.values(config).every((value) => value === undefined);

const CharacterDraftContext = createContext<CharacterDraft | null>(null);

export function CharacterDraftProvider({
  identity,
  store,
  children,
}: {
  readonly identity: string;
  /** An agent not on the canvas yet keeps its character here, not in the seat store. */
  readonly store?: AgentEditorDraft;
  readonly children: ReactNode;
}) {
  const saved = usePortraitConfig(identity);
  const [draft, setDraft] = useState<PortraitConfig>((store ? store.portrait : saved) ?? {});
  const [saveFailed, setSaveFailed] = useState(false);
  const [preview, setPreview] = useState<CharacterPreview | undefined>(undefined);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => pending.current && clearTimeout(pending.current), []);

  const replace = (next: PortraitConfig): void => {
    setDraft(next);
    if (store) {
      store.setPortrait(isEmptyConfig(next) ? undefined : next);
      return;
    }
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void savePortraitOverride(identity, isEmptyConfig(next) ? null : next).then((ok) => setSaveFailed(!ok));
    }, SAVE_DEBOUNCE_MS);
  };
  const value: CharacterDraft = {
    identity,
    draft,
    character: portraitCharacter(identity, draft),
    saveFailed,
    set: (key, next) => replace({ ...draft, [key]: next }),
    replace,
    preview,
    setPreview,
  };
  return <CharacterDraftContext.Provider value={value}>{children}</CharacterDraftContext.Provider>;
}

export const useCharacterDraft = (): CharacterDraft => {
  const value = useContext(CharacterDraftContext);
  if (!value) throw new Error("useCharacterDraft outside the agent editor");
  return value;
};
