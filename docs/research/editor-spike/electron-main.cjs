// Opens the spike page in a shown window, Electron's own Chromium, no throttling.
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { backgroundThrottling: false } });
  win.loadURL(process.env.SPIKE_URL);
});
