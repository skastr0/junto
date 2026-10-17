/**
 * The shape of a harness model id and its label, wherever one crosses a
 * trust boundary: the link's inventory snapshot and a model value written to
 * a harness's own config. One constant each, so the two cannot drift.
 *
 * Claude's context-window ids carry brackets (`opus[1m]`) and OpenRouter's
 * latest aliases a tilde (`openrouter/~anthropic/claude-opus-latest`). No
 * quote, angle bracket, space, control, bidi or zero-width character, so an
 * id is safe as a TOML or JSON string value. Never place one in a shell
 * string. A label is shown as plain text only, and a picker keys on the id.
 *
 * Effect-free: the preload may reach this module.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/@+~[\]-]{1,200}$/;
export const MODEL_LABEL_PATTERN = /^[\p{L}\p{N} ._:/()+,[\]@~-]{1,80}$/u;

export const isModelId = (value: string): boolean => MODEL_ID_PATTERN.test(value);
export const isModelLabel = (value: string): boolean => MODEL_LABEL_PATTERN.test(value);
