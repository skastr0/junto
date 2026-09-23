/**
 * Customer-facing recovery when product startup cannot open durable state.
 *
 * Mirrors startup-schema-recovery: headless stays log+quit; GUI gets a native
 * error dialog with plain-language copy, data-safe reassurance, a pointer to
 * GitHub issues, and a sanitized technical fragment. Never offers wipe/reset.
 */

import { dialog } from "electron";
import { PRODUCT_NAME } from "@shared/product-name";

/** Operator-facing location of the sole durable store (tilde form). */
export const OPERATOR_STATE_DIR_DISPLAY = "~/.junto/state/" as const;

/** Junto has no support email; problems are reported as GitHub issues. */
export const ISSUES_URL = "https://github.com/skastr0/junto/issues" as const;

const TECHNICAL_FRAGMENT_MAX = 280;

export type StartupStateFailureDialog = {
  readonly showMessageBox: (options: {
    readonly type: "error";
    readonly buttons: readonly string[];
    readonly defaultId: number;
    readonly cancelId: number;
    readonly title: string;
    readonly message: string;
    readonly detail: string;
  }) => Promise<{ readonly response: number }>;
};

export type StartupStateFailureOutcome = {
  readonly action: "quit";
  readonly reason: string;
};

export type StartupStateFailureCopy = {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
};

const defaultDialog = (): StartupStateFailureDialog => ({
  showMessageBox: async (options) => {
    const result = await dialog.showMessageBox({
      type: options.type,
      buttons: [...options.buttons],
      defaultId: options.defaultId,
      cancelId: options.cancelId,
      title: options.title,
      message: options.message,
      detail: options.detail,
      noLink: true,
    });
    return { response: result.response };
  },
});

const firstLine = (value: string): string =>
  value.split(/\r?\n/u)[0]?.trim() ?? "";

/**
 * Flatten unknown startup failures into a single report-ready string.
 * Prefers tagged StateEngineError.message when present.
 */
export const extractStartupFailureText = (error: unknown): string => {
  if (error === undefined || error === null) return "unknown error";

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const tag = record._tag;
    const message =
      typeof record.message === "string" ? firstLine(record.message) : "";
    const operation =
      typeof record.operation === "string" ? record.operation.trim() : "";

    if (tag === "StateEngineError" || operation.length > 0) {
      if (message.length > 0 && operation.length > 0) {
        return `state ${operation}: ${message}`;
      }
      if (message.length > 0) return message;
      if (operation.length > 0) return `state ${operation} failed`;
    }

    if (message.length > 0) return message;

    if (error instanceof Error) {
      return message.length > 0 ? message : error.name || "Error";
    }
  }

  if (typeof error === "string") {
    const trimmed = firstLine(error);
    return trimmed.length > 0 ? trimmed : "unknown error";
  }

  try {
    return firstLine(String(error)) || "unknown error";
  } catch {
    return "unknown error";
  }
};

/**
 * Collapse and redact a technical fragment for the dialog footer.
 * No secrets, no multi-kilobyte dumps, no stack frames.
 */
export const sanitizeTechnicalErrorFragment = (raw: string): string => {
  let text = raw.replace(/\r\n|\r|\n/gu, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return "unavailable";

  // Redact common secret-bearing patterns (value only).
  text = text
    .replace(
      /\b(bearer|token|password|secret|api[_-]?key|authorization)\s*[=:]\s*\S+/giu,
      "$1=[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/gu, "[redacted-jwt]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/gu, "[redacted-key]");

  if (text.length > TECHNICAL_FRAGMENT_MAX) {
    text = `${text.slice(0, TECHNICAL_FRAGMENT_MAX - 1)}…`;
  }
  return text;
};

/** Pure copy builder — unit-tested without Electron. */
export const buildStartupStateFailureCopy = (input: {
  readonly error: unknown;
  readonly stateDirDisplay?: string;
}): StartupStateFailureCopy => {
  const stateDir = input.stateDirDisplay ?? OPERATOR_STATE_DIR_DISPLAY;
  const technical = sanitizeTechnicalErrorFragment(
    extractStartupFailureText(input.error),
  );

  const title = "Could not start";
  const message = `${PRODUCT_NAME} could not open its data store`;
  const detail = [
    `Something prevented ${PRODUCT_NAME} from opening your local data.`,
    "",
    `Your data was not deleted. It is still on disk at ${stateDir}`,
    "",
    `If this keeps happening, open an issue at ${ISSUES_URL} with the technical details below.`,
    "",
    `Technical: ${technical}`,
  ].join("\n");

  return { title, message, detail };
};

/**
 * Headless: log + quit (no dialog).
 * GUI: native error dialog, then quit. Primary action is Quit only.
 */
export const runStartupStateFailureDialog = async (input: {
  readonly error: unknown;
  readonly headless: boolean;
  readonly stateDirDisplay?: string;
  readonly dialog?: StartupStateFailureDialog;
}): Promise<StartupStateFailureOutcome> => {
  const copy = buildStartupStateFailureCopy({
    error: input.error,
    ...(input.stateDirDisplay === undefined
      ? {}
      : { stateDirDisplay: input.stateDirDisplay }),
  });

  const technical = sanitizeTechnicalErrorFragment(
    extractStartupFailureText(input.error),
  );
  console.error(
    `[startup] state/data open failure (${technical})`,
  );

  if (input.headless) {
    return { action: "quit", reason: "startup-state-failure-headless" };
  }

  const ui = input.dialog ?? defaultDialog();
  await ui.showMessageBox({
    type: "error",
    buttons: ["Quit"],
    defaultId: 0,
    cancelId: 0,
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
  });

  return { action: "quit", reason: "startup-state-failure" };
};
