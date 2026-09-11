/** Untrusted model output in titles — cap, strip controls/CSI, keep printable. */

const TITLE_MAX = 256;
/** C0 + C1 controls (includes ESC). */
const CONTROL_OR_C1 = /[\u0000-\u001f\u007f-\u009f]/g;
/** Residual CSI / SGR fragments after ESC was stripped, e.g. `[0m`. */
const BARE_CSI_FRAGMENT = /\[[0-9;?]*[A-Za-z]/g;

export const sanitizeTitle = (raw: string): string => {
  const stripped = raw
    .replace(CONTROL_OR_C1, "")
    .replace(BARE_CSI_FRAGMENT, "")
    .trim();
  if (stripped.length <= TITLE_MAX) return stripped;
  return stripped.slice(0, TITLE_MAX);
};
