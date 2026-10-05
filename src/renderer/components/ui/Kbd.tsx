import { Fragment, type HTMLAttributes, type ReactNode } from "react";

/**
 * Kbd — mono instrument key / gesture chip. One treatment for help maps,
 * command cards, and any surface that names a hotkey or pointer action.
 *
 * `size`: sm (the default) is the glance size for footers and hints; md is
 * for a list where the keys are read and compared (Settings, Keyboard).
 */
export function Kbd({
  children,
  size = "sm",
  className,
  ...rest
}: {
  readonly children: ReactNode;
  readonly size?: "sm" | "md";
  readonly className?: string;
} & HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={["help-map__kbd", size === "md" ? "help-map__kbd--md" : "", className ?? ""].filter(Boolean).join(" ")}
      {...rest}
    >
      {children}
    </kbd>
  );
}

/**
 * KeyChord — a shortcut as key caps. Keys pressed together sit side by side
 * with no plus sign between them; steps pressed one after another are joined
 * by the word "then". The caller hands in display strings already chosen for
 * the platform (⌘ or Ctrl); this only draws them.
 *
 *   <KeyChord steps={[["⌘", "K"]]} />            ⌘ K
 *   <KeyChord steps={[["G"], ["A"]]} />          G then A
 */
export function KeyChord({
  steps,
  size = "sm",
  label,
}: {
  /** One entry per step; each step is the keys held together. */
  readonly steps: ReadonlyArray<ReadonlyArray<string>>;
  readonly size?: "sm" | "md";
  /** How assistive tech reads it: "Command K". Defaults to the keys joined by spaces. */
  readonly label?: string;
}) {
  const spoken = label ?? steps.map((keys) => keys.join(" ")).join(", then ");
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" role="img" aria-label={spoken}>
      {steps.map((keys, stepIndex) => (
        <Fragment key={stepIndex}>
          {stepIndex > 0 ? <span className="text-label text-faint">then</span> : null}
          <span className="inline-flex items-center gap-1" aria-hidden>
            {keys.map((key, keyIndex) => (
              <Kbd key={keyIndex} size={size}>
                {key}
              </Kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
