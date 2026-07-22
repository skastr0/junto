import type { WebContents } from "electron";

let trusted: WebContents | undefined;

export const setTrustedMainWebContents = (wc: WebContents | undefined): void => {
  trusted = wc;
};

export const getTrustedMainWebContents = (): WebContents | undefined => {
  if (!trusted || trusted.isDestroyed()) return undefined;
  return trusted;
};
