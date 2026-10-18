/** Dispatch names are data; reading argv must not load their implementations. */
export const COMPANION_STDIO_COMMAND = "companion-stdio";
/** Run by a seat's post-commit hook only; agents never call it, so no docs name it. */
export const COMMIT_OBSERVED_COMMAND = "commit-observed";
