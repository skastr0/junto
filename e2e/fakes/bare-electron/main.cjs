// Control for quit-bound.spec.ts: the least an Electron app can be (one
// hidden window, nothing else). If this cannot quit, the machine cannot quit
// any Electron window, and a Junto quit stall is not Junto's.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("data:text/html,<p>bare</p>");
});
