/**
 * Grid region extractors for harness state rules.
 * Region concepts: viewport-sized tail,
 * horizontal-rule slices, prompt-box body between ─── rules.
 */

const HORIZONTAL_RULE = /^─{3,}/u;

export const isHorizontalRule = (line: string): boolean => {
  const t = line.trimEnd();
  if (t.length === 0) return false;
  return HORIZONTAL_RULE.test(t);
};

/** Last n non-empty lines (from the nth-from-last non-blank through end). */
export const bottomNonEmptyLines = (
  lines: readonly string[],
  n: number,
): readonly string[] => {
  if (n <= 0 || lines.length === 0) return [];
  const nonEmptyIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) nonEmptyIdx.push(i);
  }
  if (nonEmptyIdx.length === 0) return [];
  const startIdx = nonEmptyIdx[Math.max(0, nonEmptyIdx.length - n)]!;
  return lines.slice(startIdx);
};

export const footerLine = (lines: readonly string[]): string => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trimEnd();
    if (t.length > 0) return t;
  }
  return "";
};

/** Text after the last horizontal-rule line (exclusive of the rule). */
export const afterLastHorizontalRule = (
  lines: readonly string[],
): readonly string[] => {
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i]!)) last = i;
  }
  if (last < 0) return lines;
  return lines.slice(last + 1);
};

/**
 * Between the 2nd-from-last and last ─── rules (prompt box body).
 * Falls back to afterLastHorizontalRule when fewer than two rules exist.
 */
export const promptBoxBody = (lines: readonly string[]): readonly string[] => {
  const ruleIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i]!)) ruleIdx.push(i);
  }
  if (ruleIdx.length < 2) return afterLastHorizontalRule(lines);
  const top = ruleIdx[ruleIdx.length - 2]!;
  const bottom = ruleIdx[ruleIdx.length - 1]!;
  if (bottom <= top + 1) return [];
  return lines.slice(top + 1, bottom);
};

export const abovePromptBox = (lines: readonly string[]): readonly string[] => {
  const ruleIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isHorizontalRule(lines[i]!)) ruleIdx.push(i);
  }
  if (ruleIdx.length < 2) {
    // Single rule: everything above it.
    if (ruleIdx.length === 1) return lines.slice(0, ruleIdx[0]!);
    return lines;
  }
  const top = ruleIdx[ruleIdx.length - 2]!;
  return lines.slice(0, top);
};

export const extractRegion = (
  lines: readonly string[],
  region: string,
  n = 5,
): readonly string[] => {
  switch (region) {
    case "whole_recent":
      return lines;
    case "bottom_non_empty_lines":
      return bottomNonEmptyLines(lines, n);
    case "footer_line": {
      const f = footerLine(lines);
      return f ? [f] : [];
    }
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(lines);
    case "prompt_box_body":
      return promptBoxBody(lines);
    case "above_prompt_box":
      return abovePromptBox(lines);
    default:
      return lines;
  }
};
