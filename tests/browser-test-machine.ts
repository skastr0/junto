/** Explicit machine identity for tests that exercise browser creation here. */
export const LOCAL_BROWSER_TEST_MACHINE = "studio";

/**
 * Async like the product's own read: main holds no copy of this machine's
 * name, so the browser session service asks for it and fails closed.
 */
export const localBrowserTestMachineName = async (): Promise<string> =>
  LOCAL_BROWSER_TEST_MACHINE;
