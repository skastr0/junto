/**
 * A task's title as a sentence carries it: one line, at most
 * TASK_TITLE_WORDS_MAX characters, cut with an ellipsis. One rule, because a
 * sentence that names a task (`canvas-needs.ts`) and the card that reads the
 * number back as a chip must agree on the words, or the title prints twice.
 */
export const TASK_TITLE_WORDS_MAX = 60;

export const taskTitleWords = (title: string): string => {
  const oneLine = title.trim().replace(/\s+/gu, " ");
  return oneLine.length > TASK_TITLE_WORDS_MAX ? `${oneLine.slice(0, TASK_TITLE_WORDS_MAX - 1).trimEnd()}…` : oneLine;
};
