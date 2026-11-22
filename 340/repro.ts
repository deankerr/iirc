// Usage: bun repro.ts <css-dir> <out-prefix>
// Mirrors the DOM StillImage and OpensLarger draw, with the app's real stylesheets.
import { chromium, firefox } from "/home/dean/.t3/worktrees/iirc/340-svg-no-pixel-size-67e53b8c9691a2ca/packages/daemon/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";
const [cssDir, out] = process.argv.slice(2);
const css = ["ui/theme.css", "previews/message-previews.module.css", "previews/preview-image.module.css", "previews/larger-view.module.css"]
  .map((p) => readFileSync(`${cssDir}/${p}`, "utf8")).join("\n");
const svgs: Record<string, string> = {
  "viewbox-wide.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><rect width="400" height="100" fill="#3a7"/><circle cx="50" cy="50" r="40" fill="#fc3"/></svg>`,
  "viewbox-tall.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 400"><rect width="100" height="400" fill="#37a"/><circle cx="50" cy="50" r="40" fill="#fc3"/></svg>`,
  "nosize.svg": `<svg xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#a37"/><circle cx="50" cy="50" r="40" fill="#fc3"/></svg>`,
  "pixels.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#7a3"/><circle cx="60" cy="60" r="40" fill="#fc3"/></svg>`,
};
let png: Uint8Array;
const server = Bun.serve({ port: 0, fetch(req) {
  const name = new URL(req.url).pathname.slice(1);
  if (name === "pic.png") return new Response(png, { headers: { "content-type": "image/png" } });
  if (svgs[name]) return new Response(svgs[name], { headers: { "content-type": "image/svg+xml" } });
  return new Response(page, { headers: { "content-type": "text/html" } });
} });
const card = (id: string, src: string, dims?: [number, number]) => `
<li class="row"><div class="card" data-preview="ready"><div class="words"><bdi class="title">${id}</bdi></div>
<span class="whole" data-loaded="false" ${dims ? "" : "data-still=\"true\""} ${dims ? `data-reserved="true" style="--box-height:${dims[1]};--box-width:${dims[0]};--box-at-most:${dims[0]}px"` : ""}>
<button type="button" class="press"><img id="${id}" class="picture" data-drawn="media" alt="${id}" src="${src}"></button></span></div></li>`;
const cases = [["viewbox-wide", "/viewbox-wide.svg"], ["viewbox-tall", "/viewbox-tall.svg"], ["nosize", "/nosize.svg"],
  ["png-dims", "/pic.png", [200, 100]], ["pixels-svg-dims", "/pixels.svg", [240, 120]], ["png-nodims", "/pic.png"]] as const;
const large = (src: string) => `<div class="overlay"><div class="modal"><section class="dialog"><button class="closes"><img id="large" alt="x" class="large" src="${src}"></button><a class="page" href="#">example.com/x.svg</a></section></div></div>`;
let page = "";
const build = (body: string) => `<!doctype html><html data-theme="dark"><head><style>${css}
body{margin:0;background:#111;color:#ddd;font:14px sans-serif;width:640px}</style></head><body>${body}
<script>for (const i of document.querySelectorAll('.whole img')) i.addEventListener('load', () => i.closest('.whole').dataset.loaded = 'true');</script></body></html>`;
for (const [name, type] of [["chromium", chromium], ["firefox", firefox]] as const) {
  const browser = await type.launch();
  const p = await browser.newPage({ viewport: { width: 640, height: 1400 } });
  await p.setContent(`<div style="width:200px;height:100px;background:linear-gradient(90deg,#c63,#36c)"></div>`);
  png = await p.locator("div").screenshot();
  page = build(`<ul class="previews" style="--preview-media-height:180px">${cases.map(([id, src, d]) => card(id, src, d as any)).join("")}</ul>`);
  await p.goto(server.url.href);
  await p.waitForFunction(() => [...document.images].every((i) => i.complete) && [...document.querySelectorAll('.whole')].every((w) => w.dataset.loaded === 'true'));
  const sizes = await p.evaluate(() => [...document.images].map((i) => `${i.id}: ${Math.round(i.getBoundingClientRect().width)}x${Math.round(i.getBoundingClientRect().height)}`));
  console.log(name, "card", sizes.join(" | "));
  await p.screenshot({ path: `${out}-${name}-card.png`, fullPage: true });
  for (const src of ["viewbox-wide.svg", "viewbox-tall.svg", "nosize.svg", "pic.png", "pixels.svg"]) {
    await p.setViewportSize({ width: 900, height: 600 });
    page = build(large(`/${src}`));
    await p.goto(server.url.href);
    await p.waitForFunction(() => document.images[0].complete);
    const r = await p.evaluate(() => { const b = document.images[0].getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; });
    console.log(name, "large", src, r);
    await p.screenshot({ path: `${out}-${name}-large-${src.replace(/\W/g, "_")}.png` });
    await p.setViewportSize({ width: 640, height: 1400 });
  }
  await browser.close();
}
server.stop();
