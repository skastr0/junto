import { use$ } from "@legendapp/state/react";
import { useEffect, useRef, useState } from "react";
import {
  machineDetailFor,
  machineFigureDataUri,
  machineFigureKey,
  type MachineFigureRequest,
  type MachineFigureState,
  type MachineForm,
  type MachineFrame,
} from "@shared/machine-figure";
import type { ThemeMode } from "@shared/theme";
import { themeMode$ } from "../../lib/theme-mode";

// The machine figure: a machine drawn as a printed solid, with its state
// painted over it. The SVG is built once per machine + state + theme + tier
// and served as a data-URI <img>, the way a seat portrait is: one element,
// rasterized and cached by the browser. There is no rendering context and no
// loop. The only motion is the hover turn at the large size, a short tween
// that ends; at rest nothing runs.
//
//   <MachineFigure machine={{ name, label, form, isThisMachine }} state={state} size={28} />

const CACHE_LIMIT = 2000;
const cache = new Map<string, string>();

/** Cached data URI for one drawing of a machine. */
export function machineFigureSrc(request: MachineFigureRequest): string {
  const key = machineFigureKey(request);
  let src = cache.get(key);
  if (src === undefined) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    src = machineFigureDataUri(request);
    cache.set(key, src);
  }
  return src;
}

export interface MachineFigureMachine {
  /** The machine's short name: its identity. */
  readonly name: string;
  /** What the operator reads; the accessible name. */
  readonly label: string;
  readonly form: MachineForm;
  readonly isThisMachine: boolean;
  /** The operator's hue choice, a theme hue token. */
  readonly hue?: string;
}

export interface MachineFigureProps {
  readonly machine: MachineFigureMachine;
  readonly state: MachineFigureState;
  /** Rendered box in CSS px, square; picks the detail tier. */
  readonly size: number;
  /** Paint for a specific mode; defaults to the live theme. */
  readonly theme?: ThemeMode;
  readonly frame?: MachineFrame;
  /** The seats running there, to stand on the roof at the large size. */
  readonly crew?: MachineFigureRequest["crew"];
  /** Turn on hover. Defaults to on at the large size, and is never on below it. */
  readonly turns?: boolean;
}

// The turn stays inside the angles where every form still reads; past them
// the laptop goes edge on.
const HOVER_TURN = -30;
const TURN_MS = 320;
const TURN_MIN_SIZE = 72;

const prefersStill = (): boolean =>
  typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Tween toward a target turn and stop. No frame is requested at rest. */
function useTurn(enabled: boolean): readonly [number, (to: number) => void] {
  const [turn, setTurn] = useState(0);
  const current = useRef(0);
  const frame = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const go = (to: number): void => {
    if (!enabled || prefersStill()) return;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    const from = current.current;
    const started = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / TURN_MS);
      const next = Math.round(from + (to - from) * (1 - (1 - t) ** 3));
      current.current = next;
      setTurn(next);
      frame.current = t < 1 ? requestAnimationFrame(step) : undefined;
    };
    frame.current = requestAnimationFrame(step);
  };
  return [enabled ? turn : 0, go];
}

export function MachineFigure({ machine, state, size, theme, frame = "bare", crew, turns }: MachineFigureProps) {
  const live = use$(themeMode$);
  const mode = theme ?? live;
  const turnable = (turns ?? true) && size >= TURN_MIN_SIZE;
  const [turn, turnTo] = useTurn(turnable);
  const src = machineFigureSrc({
    name: machine.name,
    form: machine.form,
    isThisMachine: machine.isThisMachine,
    hue: machine.hue,
    state,
    mode,
    detail: machineDetailFor(size),
    frame,
    crew,
    turn,
  });
  return (
    <span
      className="machine-figure"
      data-machine-form={machine.form}
      style={{ display: "inline-block", flex: "none", width: size, height: size, lineHeight: 0 }}
      onPointerEnter={turnable ? () => turnTo(HOVER_TURN) : undefined}
      onPointerLeave={turnable ? () => turnTo(0) : undefined}
    >
      <img src={src} width={size} height={size} alt={machine.label} draggable={false} style={{ display: "block" }} />
    </span>
  );
}
