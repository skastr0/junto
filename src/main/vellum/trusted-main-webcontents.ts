import type { IpcMain, WebContents } from "electron";
import type { TrustedRendererOrigin } from "@shared/trusted-renderer-origin";

let trusted: { readonly webContents: WebContents; readonly origin: TrustedRendererOrigin } | undefined;

export class TrustedRendererRefused extends Error {
  constructor(context?: string, candidate?: WebContents) {
    let detail = context ? `on ${context} — ` : "";
    detail += "sender is not the committed trusted renderer";
    if (
      candidate !== undefined &&
      typeof candidate.isDestroyed === "function" &&
      !candidate.isDestroyed()
    ) {
      try {
        detail += ` (id=${candidate.id}, url=${candidate.getURL()})`;
      } catch {
        detail += ` (id=${candidate.id})`;
      }
    }
    super(`renderer IPC refused: ${detail}`);
    this.name = "TrustedRendererRefused";
  }
}

export const setTrustedMainWebContents = (
  wc: WebContents | undefined,
  origin?: TrustedRendererOrigin,
): void => {
  trusted = wc === undefined || origin === undefined ? undefined : { webContents: wc, origin };
};

export const getTrustedMainWebContents = (): WebContents | undefined => {
  if (!trusted || trusted.webContents.isDestroyed()) return undefined;
  try {
    return trusted.origin.allows(trusted.webContents.getURL()) ? trusted.webContents : undefined;
  } catch {
    return undefined;
  }
};

export const isTrustedMainWebContents = (candidate: WebContents): boolean =>
  getTrustedMainWebContents() === candidate;

export const assertTrustedMainWebContents = (
  candidate: WebContents,
  context?: string,
): void => {
  if (!isTrustedMainWebContents(candidate)) {
    throw new TrustedRendererRefused(context, candidate);
  }
};

type IpcListener = (event: { readonly sender: WebContents }, ...args: ReadonlyArray<unknown>) => unknown;

/**
 * A narrow facade for renderer-facing registration. Every handler registered
 * through it checks both the minted WebContents object and its live committed
 * renderer authority before application code sees arguments.
 */
export const trustedRendererIpc = (target: IpcMain): IpcMain =>
  new Proxy(target, {
    get(raw, property, receiver) {
      if (property !== "handle" && property !== "on") {
        const value = Reflect.get(raw, property, receiver);
        return typeof value === "function" ? value.bind(raw) : value;
      }
      return (channel: string, listener: IpcListener): void => {
        const register = Reflect.get(raw, property, raw) as (
          name: string,
          callback: IpcListener,
        ) => void;
        register(channel, (event, ...args) => {
          assertTrustedMainWebContents(event.sender, channel);
          return listener(event, ...args);
        });
      };
    },
  }) as IpcMain;
