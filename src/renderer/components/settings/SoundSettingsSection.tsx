/**
 * Settings -> Sound: the master level and switch, then one row per sound
 * family (most urgent first) with its level, its switch, and every cue in
 * it to hear. Levels commit once per drag through settingsPatch; releasing a
 * slider plays the family's first cue at the new level, so the operator
 * hears what they just set.
 */
import { use$ } from "@legendapp/state/react";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SOUND_CATEGORIES, soundCategoryPrefs, type SoundCategory } from "@shared/settings";
import { patchSettings } from "../../lib/settings-state";
import {
  CATEGORY_LABEL,
  CUE_IDS,
  CUES,
  cuesInCategory,
  previewCue,
  previewCues,
  type CueId,
} from "../../lib/sound";
import { state$ } from "../../lib/state";
import { Button, Slider, Switch } from "../ui";

/** Matches the engine's gap between cues in a preview run. */
const PREVIEW_GAP_MS = 450;

/** Which cue is sounding now, so its chip can say so. */
const usePlaying = () => {
  const [playing, setPlaying] = useState<CueId>();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clear = (): void => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clear, []);
  const follow = (run: ReadonlyArray<CueId>): void => {
    clear();
    let at = 0;
    for (const cue of run) {
      timers.current.push(setTimeout(() => setPlaying(cue), at));
      at += CUES[cue].seconds * 1_000 + PREVIEW_GAP_MS;
    }
    timers.current.push(setTimeout(() => setPlaying(undefined), Math.max(0, at - PREVIEW_GAP_MS)));
  };
  return { playing, follow };
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function CueChip({
  cue,
  playing,
  disabled,
  onPlay,
}: {
  readonly cue: CueId;
  readonly playing: boolean;
  readonly disabled: boolean;
  readonly onPlay: () => void;
}) {
  return (
    <Button
      variant="chrome"
      size="sm"
      disabled={disabled}
      aria-pressed={playing}
      title={CUES[cue].meaning}
      // aria-pressed variants sort after the button's own colours, so they win.
      className="aria-pressed:border-amber/50 aria-pressed:bg-amber/[0.12] aria-pressed:text-amber"
      onClick={onPlay}
    >
      <Play size={9} aria-hidden className={playing ? "fill-current" : undefined} />
      {CUES[cue].label}
    </Button>
  );
}

function FamilyRow({
  category,
  masterOff,
  playing,
  onPlay,
}: {
  readonly category: SoundCategory;
  readonly masterOff: boolean;
  readonly playing: CueId | undefined;
  readonly onPlay: (run: ReadonlyArray<CueId>) => void;
}) {
  const prefs = use$(() => soundCategoryPrefs(state$.settings.audio.get(), category));
  const cues = cuesInCategory(category);
  const id = `sound-family-${category}`;
  const off = masterOff || !prefs.enabled;
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 border-b border-stroke py-4"
      data-testid={id}
      data-on={prefs.enabled ? "true" : "false"}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className={`cursor-pointer text-[14px] font-semibold ${off ? "text-dim" : "text-ink"}`}>
          {CATEGORY_LABEL[category].title}
        </label>
        <p className="m-0 text-[12px] leading-[1.5] text-dim">{CATEGORY_LABEL[category].hint}</p>
      </div>
      <div className="flex items-center gap-3 pt-[2px]">
        <div className="w-[132px]">
          <Slider
            value={prefs.volume}
            label={`${CATEGORY_LABEL[category].title} volume`}
            disabled={off}
            onCommit={(volume) => {
              void patchSettings({ audio: { sounds: { [category]: { volume } } } }).then(() =>
                onPlay([cues[0]!]),
              );
            }}
          />
        </div>
        <span className={`w-9 text-right text-[11px] tabular-nums ${off ? "text-faint" : "text-dim"}`}>
          {percent(prefs.volume)}
        </span>
        <Switch
          id={id}
          checked={prefs.enabled}
          disabled={masterOff}
          onCheckedChange={(enabled) => void patchSettings({ audio: { sounds: { [category]: { enabled } } } })}
        />
      </div>
      <div className="col-span-2 flex flex-wrap gap-1.5">
        {cues.map((cue) => (
          <CueChip key={cue} cue={cue} playing={playing === cue} disabled={off} onPlay={() => onPlay([cue])} />
        ))}
      </div>
    </div>
  );
}

export function SoundSettingsSection() {
  const audio = use$(state$.settings.audio);
  const { playing, follow } = usePlaying();
  const on = !audio.muted;

  const play = (run: ReadonlyArray<CueId>): void => {
    const current = state$.settings.audio.peek();
    const audible = run.filter((cue) => soundCategoryPrefs(current, CUES[cue].category).enabled);
    if (current.muted || audible.length === 0) return;
    if (audible.length === 1) previewCue(audible[0]!);
    else previewCues(audible);
    follow(audible);
  };

  // Calm to urgent, so the run builds the way the app's sounds do.
  const everyCue = [...CUE_IDS].sort((a, b) => CUES[a].urgency - CUES[b].urgency);

  return (
    <div className="settings-section" data-testid="settings-sound-section">
      <p className="m-0 max-w-[62ch] text-[12px] leading-[1.5] text-dim">
        Junto plays a short sound when an agent changes state. The more a sound needs you, the louder it
        is; the rest stay in the background. When many agents move at once, you hear a few notes, not all
        of them.
      </p>
      <div className="flex flex-col border-t border-stroke">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 border-b border-stroke py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="sound-master" className="cursor-pointer text-[14px] font-semibold text-ink">
              All sounds
            </label>
            <p className="m-0 text-[12px] leading-[1.5] text-dim">
              {on ? "Every family below, together." : "Junto is silent."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-[132px]">
              <Slider
                value={audio.masterVolume}
                label="All sounds volume"
                disabled={!on}
                onCommit={(masterVolume) => {
                  void patchSettings({ audio: { masterVolume } }).then(() => play(["done"]));
                }}
              />
            </div>
            <span className={`w-9 text-right text-[11px] tabular-nums ${on ? "text-dim" : "text-faint"}`}>
              {percent(audio.masterVolume)}
            </span>
            <Switch
              id="sound-master"
              checked={on}
              onCheckedChange={(next) => void patchSettings({ audio: { muted: !next } })}
            />
          </div>
        </div>
        {SOUND_CATEGORIES.map((category) => (
          <FamilyRow key={category} category={category} masterOff={!on} playing={playing} onPlay={play} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="chrome" size="md" disabled={!on} onClick={() => play(everyCue)}>
          <Play size={11} aria-hidden />
          Play every sound
        </Button>
        <span className="text-[11px] text-dim">Calm to urgent, at your levels.</span>
      </div>
    </div>
  );
}
