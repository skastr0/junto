/**
 * The core and the PTYs leave main together. A core in its own process with
 * the PTYs still in main splits the terminal plane: a seat would start on the
 * core's plane while attach and write stay on main's. Boot refuses that pair
 * outright, never falling back, so a split plane cannot ship.
 */
export const splitPlaneRefusal = (flags: { readonly core: boolean; readonly terminal: boolean }): string | undefined =>
  flags.core && !flags.terminal
    ? "Junto will not start: the core runs in its own process but the terminals do not. Turn both on, or set JUNTO_CORE_PROCESS=0 to keep the core in the app."
    : undefined;
