/**
 * The launch context Add item last held on a canvas: the machine and the
 * folder the operator chose. Add item reopens on them, so a folder picked
 * once is not lost to a closed dialog and a new seat never falls back to
 * the home folder by accident.
 */

export type RememberedLaunch = {
  readonly hostId: string;
  /** Folder per machine: a path picked on one machine means nothing on another. */
  readonly cwdByHost: Readonly<Record<string, string>>;
};

const remembered = new Map<string, RememberedLaunch>();

export const rememberedLaunch = (canvasName: string): RememberedLaunch | undefined =>
  remembered.get(canvasName);

/** The folder last chosen on `hostId` in this canvas, if any. */
export const rememberedCwd = (canvasName: string, hostId: string): string | undefined =>
  remembered.get(canvasName)?.cwdByHost[hostId];

/** Note the machine shown, and the folder chosen on it when there is one. */
export const rememberLaunch = (canvasName: string, hostId: string, cwd: string): void => {
  const previous = remembered.get(canvasName);
  const cwdByHost = { ...(previous?.cwdByHost ?? {}) };
  if (cwd.trim() !== "") cwdByHost[hostId] = cwd;
  remembered.set(canvasName, { hostId, cwdByHost });
};

/** Tests only. */
export const forgetLaunches = (): void => {
  remembered.clear();
};

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * Pure: whether `path` is the machine's home folder itself. A seat must
 * name a project folder; home is where the operator's whole account lives,
 * and a harness started there asks to trust all of it.
 */
export const isHomeFolder = (path: string, homeRoot: string | undefined): boolean => {
  const trimmed = trimSlash(path.trim());
  if (trimmed === "~") return true;
  return homeRoot !== undefined && homeRoot !== "" && trimmed === trimSlash(homeRoot);
};
