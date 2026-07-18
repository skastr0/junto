// Refined work-surface mark for "open herdr" — rounded frame + prompt stroke.
// Replaces Lucide SquareTerminal in selection chrome (toolbar + command central).
// currentColor so callers own accent (cyan primary, steel idle).
export function OpenHerdrMark({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="1.75" y="2.5" width="12.5" height="11" rx="2.25" />
      <path d="M4.75 6.25L7.25 8 4.75 9.75" />
      <path d="M8 9.75h3.25" />
    </svg>
  );
}
