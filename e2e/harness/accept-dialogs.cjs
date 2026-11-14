"use strict";

/*
 * Electron -r preload, executed before the product main module. Stubs the
 * native message box so every launch auto-accepts: response index 1 is
 * QUIT_CONFIRM_ACCEPT_INDEX ("quit anyway") and the browser grant flow uses
 * the same index for "allow".
 *
 * This replaces the post-launch app.evaluate stub. That evaluate was the
 * first main-process call after electron.launch resolved, and it intermittently
 * died with "Execution context was destroyed" while the previous app was
 * still exiting. Installed here, the stub exists before the app's own module
 * evaluates — strictly earlier than any evaluate could run, and immune to the
 * early-startup window entirely. A launch that fails before its window is
 * still torn down by a quit, and the honest-quit confirm never shows natively.
 *
 * Specs that need to observe or replace the dialog (mail-delivered-once,
 * core-boot-failure) assign dialog.showMessageBox themselves after launch and
 * still win: this runs first, they run later.
 */

const { dialog } = require("electron");

dialog.showMessageBox = async () => ({
  response: 1,
  checkboxChecked: false,
});
