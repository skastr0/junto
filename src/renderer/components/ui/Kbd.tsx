import type { HTMLAttributes, ReactNode } from "react";

/**
 * Kbd — mono instrument key / gesture chip. One treatment for help maps,
 * command cards, and any surface that names a hotkey or pointer action.
 */
export function Kbd({
  children,
  className,
  ...rest
}: {
  readonly children: ReactNode;
  readonly className?: string;
} & HTMLAttributes<HTMLElement>) {
  return (
    <kbd className={["help-map__kbd", className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {children}
    </kbd>
  );
}
