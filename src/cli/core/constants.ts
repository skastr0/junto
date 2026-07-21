declare const APP_VERSION: string | undefined;

export const CLI_NAME = "vellum";
export const CLI_VERSION = typeof APP_VERSION === "string" ? APP_VERSION : "0.1.0";
export const DEFAULT_BATCH_CONCURRENCY = 5;
export const DEFAULT_TIMEOUT_MS = 30_000;
