// Hands a MessagePort from the main process to the page, so the window's page
// and the canvas view can talk renderer to renderer.
const { ipcRenderer } = require("electron");

ipcRenderer.on("lab-port", (event) => {
  window.postMessage("lab-port", "*", event.ports);
});
