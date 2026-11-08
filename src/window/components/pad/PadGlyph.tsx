/**
 * First-party empty-pad mark. Theme tokens only — dim command room, not a crayon.
 */
export function PadGlyph({
  className,
  testId,
}: {
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 72 44"
      aria-hidden
      data-testid={testId}
    >
      <rect
        x="1"
        y="1"
        width="70"
        height="42"
        fill="var(--color-inset)"
        stroke="var(--color-stroke)"
      />
      <rect
        x="10"
        y="12"
        width="22"
        height="14"
        fill="var(--color-overlay-1)"
        stroke="var(--color-steel)"
      />
      <path
        d="M38 28 L50 22 L58 30"
        fill="none"
        stroke="var(--color-ink-2)"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="30" r="2.2" fill="var(--color-amber)" />
    </svg>
  );
}
