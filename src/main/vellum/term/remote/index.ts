/**
 * Remote terminal authority lives on the Remote station process itself
 * (term-control UDS). Command Center reaches it via TerminalRouter + SSH
 * unix-forward — not a separate client registry.
 *
 * Kept as a module path so older imports resolve; do not add a parallel host map.
 */
export {};
