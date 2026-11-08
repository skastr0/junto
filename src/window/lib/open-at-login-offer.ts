import type { LoginItemOpResult } from "@shared/ipc";
import { patchSettings } from "./settings-state";

// After the first phone pairs, the pairing view asks once whether Junto opens
// at login, so the phone keeps reaching this Mac after a restart. Junto never
// turns the login item on by itself: only the operator's yes does. The asked
// flag lives in the durable settings row (advanced.openAtLoginOffered), like
// the first-run introduction's, so either answer ends the question for good.

export interface OpenAtLoginOfferInput {
  /** The phone that just paired is the only paired phone. */
  readonly firstPhone: boolean;
  /** The durable settings row has hydrated; before that, `offered` is a default. */
  readonly settingsReady: boolean;
  readonly offered: boolean | undefined;
  /** The OS's own answer, read when the phone paired. */
  readonly loginItem: LoginItemOpResult | undefined;
}

/** Ask only when it is the first phone, never asked before, and the login item is really off. */
export const openAtLoginOfferVisible = (input: OpenAtLoginOfferInput): boolean =>
  input.firstPhone &&
  input.settingsReady &&
  input.offered !== true &&
  input.loginItem?.ok === true &&
  input.loginItem.provider === "apple-login-items" &&
  input.loginItem.state?.openAtLogin === false;

export interface OpenAtLoginPorts {
  readonly loginItemSet?: (openAtLogin: boolean) => Promise<LoginItemOpResult>;
  readonly markOffered?: () => Promise<boolean>;
}

export type OpenAtLoginAnswer =
  | { readonly ok: true; readonly openAtLogin: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * The operator answered. Yes turns the login item on and reads back what the
 * OS reports; a yes that did not stick leaves the question unasked, so the
 * next first phone asks again. No only records that it was asked.
 */
export const answerOpenAtLogin = async (
  open: boolean,
  ports: OpenAtLoginPorts = {
    loginItemSet: window.junto?.loginItemSet,
    markOffered: () => patchSettings({ advanced: { openAtLoginOffered: true } }),
  },
): Promise<OpenAtLoginAnswer> => {
  if (open) {
    const result = await ports.loginItemSet?.(true).catch(
      (error: unknown): LoginItemOpResult => ({
        ok: false,
        provider: "apple-login-items",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (result?.ok !== true || result.state?.openAtLogin !== true) {
      return { ok: false, message: result?.message ?? "Junto could not be set to open at login." };
    }
  }
  await ports.markOffered?.();
  return { ok: true, openAtLogin: open };
};
