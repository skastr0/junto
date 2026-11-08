// What IntersectionObserver (root null, no margin) reports for a part inside foreignObject.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const part = `<div class="part" style="width:40px;height:40px;background:#0ff"></div>`;
const CASES = {
  foVisible: `<svg width="400" height="300"><foreignObject x="100" y="100" width="60" height="60">${part}</foreignObject></svg>`,
  foOutsideSvg: `<svg width="400" height="300"><foreignObject x="2000" y="100" width="60" height="60">${part}</foreignObject></svg>`,
  foPannedGroupOut: `<svg width="400" height="300"><g transform="translate(-900 0)"><foreignObject x="100" y="100" width="60" height="60">${part}</foreignObject></g></svg>`,
  foInSvgOutOfWindow: `<svg width="400" height="300" style="position:absolute;left:-1000px"><foreignObject x="100" y="100" width="60" height="60">${part}</foreignObject></svg>`,
};
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 1400, show: true });
  const page = path.join(__dirname, "io.html");
  const body = Object.entries(CASES).map(([n, h]) => `<div id="${n}" style="position:relative;height:320px">${h}</div>`).join("");
  fs.writeFileSync(page, `<!doctype html><meta charset=utf-8><body style="margin:0">${body}</body>`);
  await win.loadFile(page);
  const out = await win.webContents.executeJavaScript(`new Promise((resolve) => {
    const res = {};
    const els = [...document.querySelectorAll('.part')];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) res[e.target.closest('[id]').id] = e.isIntersecting;
      if (Object.keys(res).length === els.length) resolve(res);
    });
    els.forEach((e) => io.observe(e));
  })`);
  console.log(JSON.stringify(out));
  app.quit();
});
