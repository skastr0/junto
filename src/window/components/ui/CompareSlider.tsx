import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { CompareTag } from "./Thumbnail";
import type { MediaSize } from "./MediaStage";

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * CompareSlider: two images on one spot, A under B, and a divider the
 * operator drags across. Left of the divider is A, right of it is B. Both
 * are laid out from the same corner at the sizes given, so a caller that
 * passes one scale for both gets an honest comparison.
 *
 * It is a slider for assistive tech: arrows move it 2 percent, Home and End
 * go to the edges.
 */
export function CompareSlider({
  a,
  b,
  value,
  onChange,
  labelA,
  labelB,
}: {
  readonly a: { readonly src: string; readonly size: MediaSize };
  readonly b: { readonly src: string; readonly size: MediaSize };
  /** Where the divider sits, 0 to 100 from the left. */
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly labelA: string;
  readonly labelB: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const width = Math.max(a.size.width, b.size.width);
  const height = Math.max(a.size.height, b.size.height);

  const moveTo = (clientX: number): void => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    onChange(clamp(((clientX - box.left) / box.width) * 100));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event.clientX);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next =
      event.key === "ArrowLeft" ? value - 2
      : event.key === "ArrowRight" ? value + 2
      : event.key === "Home" ? 0
      : event.key === "End" ? 100
      : null;
    if (next === null) return;
    event.preventDefault();
    // The arrows are this slider's while it holds the keyboard.
    event.stopPropagation();
    onChange(clamp(next));
  };

  return (
    <div
      ref={boxRef}
      className="relative flex-none touch-none select-none"
      style={{ width, height }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      <img
        src={a.src}
        alt={labelA}
        draggable={false}
        className="absolute left-0 top-0 max-w-none rounded-sm"
        style={{ width: a.size.width, height: a.size.height }}
      />
      <img
        src={b.src}
        alt={labelB}
        draggable={false}
        className="absolute left-0 top-0 max-w-none rounded-sm"
        style={{ width: b.size.width, height: b.size.height, clipPath: `inset(0 0 0 ${(value / 100) * width}px)` }}
      />
      <CompareTag side="A" />
      <CompareTag side="B" corner="right" />
      <div
        role="slider"
        tabIndex={0}
        aria-label={`Divider between ${labelA} and ${labelB}`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        onKeyDown={onKeyDown}
        className="group/divider absolute inset-y-0 w-px cursor-ew-resize bg-ink/60 outline-none"
        style={{ left: `${value}%` }}
      >
        {/* Says drag sideways on any picture, light or dark. */}
        <span className="absolute left-1/2 top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-pill border border-ink/60 bg-raise text-ink group-focus-visible/divider:ring-1 group-focus-visible/divider:ring-cyan/60">
          <ChevronsLeftRight size={12} aria-hidden />
        </span>
      </div>
    </div>
  );
}
