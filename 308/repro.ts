// Usage: bun repro.ts <css-root> <out-dir> <before|after>
//   <css-root>/<before|after>/{ui,timelines,previews}/*.css are the app's real stylesheets at each commit
//   (git show 45764a5c:apps/web/src/<path> for before, 5171cb6e for after).
// Builds the DOM the React components of apps/web/src produce (Sidebar, Message lines with PreviewToggle and
// MessagePreviews, EnlargeControl, OpensLarger) around those stylesheets. CSS-module class names are made
// plain by prefixing each module's own name (sidebar_item, mp_toggle, ...), so one page holds every module
// without collisions. React Aria's `data-hovered` and `aria-expanded` are set by hand.
import { chromium } from "/home/dean/.t3/worktrees/iirc/308-sidebar-preview-fix-cb09919cfb975476/packages/daemon/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const [cssRoot, outDir, variant] = process.argv.slice(2) as [string, string, "before" | "after"];
const after = variant === "after";
const read = (p: string) => readFileSync(`${cssRoot}/${variant}/${p}`, "utf8");

// ---- stylesheets, one prefix per module ----
const scope = (mod: string, css: string) =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/:global\(([^)]*)\)/g, "$1")
    .replace(/\.([A-Za-z_][\w-]*)/g, (_m, n) => `.${mod}_${n}`);
const c = (mod: string, names: string) =>
  names
    .split(" ")
    .map((n) => `${mod}_${n}`)
    .join(" ");

const modules: [string, string][] = [
  ["icon", "ui/icon.module.css"],
  ["btn", "ui/button.module.css"],
  ["sidebar", "timelines/sidebar.module.css"],
  ["line", "timelines/line.module.css"],
  ["inl", "timelines/inlines.module.css"],
  ["mp", "previews/message-previews.module.css"],
  ["pi", "previews/preview-image.module.css"],
  ["lv", "previews/larger-view.module.css"],
  ["pb", "previews/play-button.module.css"],
];
const css = [read("ui/theme.css"), ...modules.map(([m, p]) => scope(m, read(p)))].join("\n");

// ---- icons: glyph spans before; SVG for enlarge, close, play after (icon.tsx) ----
const glyphs: Record<string, string> = {
  collapsed: "▸",
  expanded: "▾",
  muted: "∅",
  hideSidebar: "«",
  more: "…",
  close: "×",
  enlarge: "⤢",
  play: "▶",
};
const drawings: Record<string, string> = {
  close: `<path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/>`,
  enlarge: `<path d="M9 3h4v4M13 3 3 13M7 13H3V9" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>`,
  play: `<path d="M5.5 3.5 13 8l-7.5 4.5z" fill="currentColor"/>`,
};
const icon = (name: string, extra = "") => {
  const inner =
    after && drawings[name]
      ? `<svg class="icon_drawing" viewBox="0 0 16 16">${drawings[name]}</svg>`
      : glyphs[name];
  return `<span aria-hidden="true" class="icon_icon ${extra}" data-icon="${name}">${inner}</span>`;
};

// ---- pictures ----
const fonts = {
  mono: `"Noto Sans Mono", var(--font-device)`,
  sans: `"Noto Sans", var(--font-device-sans)`,
} as const;

const build = (font: keyof typeof fonts, body: string, width: number) => `<!doctype html><html data-theme="dark"><head><style>${css}
:root{--font-text:${fonts[font]};--font-mono:var(--font-device);color-scheme:dark;--nick-width:10ch}
html,body{height:auto}body{width:${width}px;height:auto;margin:0}
</style></head><body>${body}</body></html>`;

// ---- Sidebar: nav > .scroll > TailRow, Networks tree; footer ----
const item = (name: string, o: { keys?: string; hovered?: boolean; level?: string; counts?: string } = {}) =>
  `<div class="${c("sidebar", "item")}" role="option" ${o.hovered ? "data-hovered" : ""}>` +
  `<span aria-hidden="true" class="${c("sidebar", "gutter pane")}"></span>` +
  `<span class="${c("sidebar", "name")} ${o.level ?? ""}">${name}</span>` +
  (o.counts ? `<span aria-hidden="true" class="${c("sidebar", "counts")}">${o.counts}</span>` : "") +
  (o.keys ? `<kbd class="${c("sidebar", "keys")}">${o.keys}</kbd>` : "") +
  `</div>`;
const net = (name: string, counts = "") =>
  `<div class="${c("sidebar", "network")}" role="row">` +
  `<button class="${c("sidebar", "chevron")}">${icon("expanded")}</button>` +
  `<bdi class="${c("sidebar", "name levelMessage")}">${name}</bdi>` +
  (counts ? `<span aria-hidden="true" class="${c("sidebar", "counts")}">${counts}</span>` : "") +
  `</div>`;
const sidebar = () => `<nav class="${c("sidebar", "sidebar")}" style="height:360px;width:280px;background:var(--color-background);outline:1px solid #444">
<div class="${c("sidebar", "scroll")}">
 <div class="${c("sidebar", "views")}">${item("iirc")}</div>
 <div class="${c("sidebar", "tree")}">
  ${net("libera")}
  ${item("#iirc", { level: c("sidebar", "levelDirect"), counts: `<span class="${c("sidebar", "direct")}">2</span>` })}
  ${item("#ircv3", { level: c("sidebar", "levelMessage"), counts: `<span class="${c("sidebar", "messages")}">14</span>` })}
  ${item("alice", { level: c("sidebar", "levelNone") })}
  ${net("oftc")}
  ${item("#debian", { level: c("sidebar", "levelNone") })}
 </div>
</div>
<footer class="${c("sidebar", "footer")}">
 <div class="${c("sidebar", "views")}">${item("Search", { keys: "Ctrl+K" })}${item("Uploads")}${item("Options")}</div>
 <div class="${c("sidebar", "controls")}">
  <button class="${c("btn", "button quiet small")}">Sign out</button>
  <button class="${c("btn", "button quiet small icon")} ${c("sidebar", "hide")}" aria-label="Hide the sidebar">${icon("hideSidebar")}</button>
 </div>
</footer></nav>`;

// ---- Timeline rows ----
let png = "";
const pic = (w: number, h: number, a: string, b: string) => ({ w, h, a, b });
const timeLine = (nick: string, text: string, previews = "", cls = "message") =>
  `<div class="${c("line", "line")}"><div class="${c("line", cls)}">` +
  `<span class="${c("line", "time")}" data-sample="00:00">12:04</span> ` +
  `<span class="${c("line", "sender")}"><span class="${c("line", "said")}">&lt;${nick}&gt;</span></span> ` +
  `<bdi class="${c("line", "text")}">${text}</bdi>${previews}</div></div>`;
const link = (href: string) => `<a class="${c("inl", "link")}" href="#">${href}</a>`;
const toggle = (open: boolean, hovered = false) =>
  `⁠<button aria-expanded="${open}" aria-label="Preview" class="${c("mp", "toggle")}" data-preview-toggle="${open ? "open" : "closed"}" ${hovered ? "data-hovered" : ""}>` +
  (after ? icon(open ? "expanded" : "collapsed") : open ? "−" : "+") +
  `</button>`;
const previews = (rows: string) =>
  `<ul aria-label="Previews" class="${c("mp", "previews")}" style="--preview-media-height:180px">${rows}</ul>`;
const still = (src: string, w: number, h: number) =>
  `<span class="${c("pi", "whole")}" data-loaded="true" data-reserved data-still style="--box-height:${h};--box-width:${w};--box-at-most:${w}px"><button class="${c("pi", "press")}"><img alt="a" class="${c("pi", "picture")}" src="${src}"></button></span>`;
const imageRow = (src: string) =>
  `<li class="${c("mp", "row")}"><div class="${c("mp", "card")}" ${after ? "data-bare" : ""} data-preview="ready">${still(src, 360, 200)}</div></li>`;
const words = (host: string, title: string, desc: string) =>
  `<div class="${c("mp", "words")}"><bdi class="${c("mp", "host")}">${host}</bdi><bdi class="${c("mp", "title")}">${title}</bdi><bdi class="${c("mp", "description")}">${desc}</bdi></div>`;
const cardRow = (src: string) =>
  `<li class="${c("mp", "row")}"><div class="${c("mp", "card")}" data-preview="ready">${words("example.org", "Why the lighthouse keeps turning", "A short history of the lamp, the keepers who tended it, and the clockwork that outlived them all.")}${still(src, 480, 252)}</div></li>`;
const enlarge = () =>
  `<button aria-label="Open x large" class="${after ? c("lv", "control") + " " : ""}${c("pi", "enlarge")}" data-hovered-slot>${icon("enlarge")}</button>`;
const videoBox = (poster: string, flat = false) =>
  `<span class="${c("pi", "boxed")}" style="--box-height:9;--box-width:16;--preview-media-height:200px">${
    flat
      ? `<div class="${c("pi", "video")}"></div>`
      : `<video class="${c("pi", "video")}" controls poster="${poster}" preload="none"></video>`
  }${enlarge()}</span>`;
const videoRow = (poster: string) =>
  `<li class="${c("mp", "row")}"><div class="${c("mp", "card")}" data-preview="ready"><div class="${c("pi", "stacked")}">${words("example.org", "Waves on a slow afternoon", "Thirty seconds of surf.")}${videoBox(poster)}</div></div></li>`;
const larger = (poster: string, flat = false) =>
  `<div class="${c("lv", "overlay")}"><div class="${c("lv", "modal")}"><section class="${c("lv", "dialog")}"><span class="${c("lv", "player")}">${
    flat
      ? `<div class="${c("lv", "large")}" style="height:380px;background:var(--color-surface)"></div>`
      : `<video class="${c("lv", "large")}" controls poster="${poster}"></video>`
  }<button aria-label="Close" class="${after ? c("lv", "control") + " " : ""}${c("lv", "close")}">${icon("close")}</button></span><a class="${c("lv", "page")}" href="#">example.org/waves.mp4</a></section></div></div>`;

// ---- run ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: 2 });

const mk = async (w: number, h: number, a: string, b: string) => {
  await page.setContent(
    `<div style="width:${w}px;height:${h}px;background:linear-gradient(135deg,${a},${b});position:relative"><div style="position:absolute;left:30%;top:30%;width:40%;height:40%;border-radius:50%;background:#fc3"></div></div>`,
  );
  const b64 = (await page.locator("div").first().screenshot()).toString("base64");
  return `data:image/png;base64,${b64}`;
};
const catImg = await mk(360, 200, "#c63", "#36c");
const cardImg = await mk(480, 252, "#2a8", "#a3c");
const poster = await mk(640, 360, "#246", "#e84");

const shoot = async (file: string, html: string, width: number, selector: string, viewport?: [number, number]) => {
  await page.setViewportSize({ width: viewport?.[0] ?? 800, height: viewport?.[1] ?? 900 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.locator(selector).first().screenshot({ path: `${outDir}/${variant}-${file}.png` });
};

const measure = async (font: keyof typeof fonts) => {
  const out: Record<string, unknown> = {};
  const scale = 4;
  const hi = await browser.newPage({ viewport: { width: 800, height: 900 }, deviceScaleFactor: scale });
  for (const [name, html, sel, vp] of [
    ["enlarge", build(font, `<ul class="${c("mp", "previews")}" style="--preview-media-height:200px"><li class="${c("mp", "row")}"><div class="${c("pi", "stacked")}">${videoBox(poster, true)}</div></li></ul>`, 700), `.${c("pi", "enlarge")}`, [800, 900]],
    ["close", build(font, larger(poster, true), 700), `.${c("lv", "close")}`, [900, 560]],
  ] as const) {
    await hi.setViewportSize({ width: vp[0], height: vp[1] });
    await hi.setContent(html);
    await hi.evaluate(() => document.fonts.ready);
    const box = (await hi.locator(sel).boundingBox())!;
    // A clip on whole CSS pixels around the control, so the pixels line up with the layout.
    const cx = Math.floor(box.x) - 2, cy = Math.floor(box.y) - 2;
    const cw = Math.ceil(box.x + box.width) + 2 - cx, ch = Math.ceil(box.y + box.height) + 2 - cy;
    const png = (await hi.screenshot({ clip: { x: cx, y: cy, width: cw, height: ch } })).toString("base64");
    const ink = await hi.evaluate(
      async ([b64, bx, by, bw, bh, ox, oy, sc]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement("canvas");
        cv.width = img.width; cv.height = img.height;
        const g = cv.getContext("2d")!;
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        const at = (x: number, y: number) => (Math.floor(y) * cv.width + Math.floor(x)) * 4;
        const p0 = at((bx - ox + 2.5) * sc, (by - oy + bh / 2) * sc);
        const bg = [d[p0], d[p0 + 1], d[p0 + 2]];
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (let y = Math.ceil((by - oy + 2) * sc); y < (by - oy + bh - 2) * sc; y++)
          for (let x = Math.ceil((bx - ox + 2) * sc); x < (bx - ox + bw - 2) * sc; x++) {
            const i = y * cv.width * 4 + x * 4;
            if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60) {
              x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
          }
        // centre and size in CSS px, in page coordinates
        return { cx: ((x0 + x1 + 1) / 2) / sc + ox, cy: ((y0 + y1 + 1) / 2) / sc + oy, w: (x1 - x0 + 1) / sc, h: (y1 - y0 + 1) / sc };
      },
      [png, box.x, box.y, box.width, box.height, cx, cy, scale] as const,
    );
    out[name] = {
      control: `${box.width}x${box.height}`,
      iconInk: `${ink.w.toFixed(1)}x${ink.h.toFixed(1)}`,
      iconCentreOffset: `dx=${(ink.cx - (box.x + box.width / 2)).toFixed(2)} dy=${(ink.cy - (box.y + box.height / 2)).toFixed(2)}`,
    };
  }
  await hi.close();
  return out;
};

const results: Record<string, unknown> = {};
for (const font of ["mono", "sans"] as const) {
  const B = (body: string, w = 760) => build(font, body, w);
  const tag = font;
  // 1. Sidebar
  await shoot(`${tag}-1-sidebar`, B(sidebar(), 280), 280, `.${c("sidebar", "sidebar")}`);
  // 2. Messages with a Preview, in the Timeline row context
  const ctx = (mid: string) =>
    `<div style="background:var(--color-background)">${timeLine("alice", "morning all")}${mid}${timeLine("carol", "the next message, which sits right under the preview")}</div>`;
  await shoot(
    `${tag}-2a-image-preview`,
    B(ctx(timeLine("bob", `look at this ${link("https://example.org/cat.png")}${toggle(true)}`, previews(imageRow(catImg))))),
    760,
    "div",
  );
  await shoot(
    `${tag}-2b-card-preview`,
    B(ctx(timeLine("bob", `worth a read ${link("https://example.org/lighthouse")}${toggle(true)}`, previews(cardRow(cardImg))))),
    760,
    "div",
  );
  // 3. The toggle: closed, closed hovered, open, open hovered
  const t = (label: string, open: boolean, hov: boolean) =>
    timeLine("bob", `${label}: ${link("https://example.org/a")}${toggle(open, hov)} and some words after it`);
  await shoot(
    `${tag}-3-toggle`,
    B(`<div style="background:var(--color-background)">${t("closed", false, false)}${t("closed, hovered", false, true)}${t("open", true, false)}${t("open, hovered", true, true)}</div>`),
    760,
    "div",
  );
  // 4. Controls over a video
  await shoot(
    `${tag}-4a-enlarge-video`,
    B(`<div style="background:var(--color-background)">${timeLine("bob", `clip ${link("https://example.org/waves.mp4")}${toggle(true)}`, previews(videoRow(poster)))}</div>`),
    760,
    "div",
  );
  await shoot(`${tag}-4b-close-larger-view`, B(larger(poster), 900), 900, `.${c("lv", "overlay")}`, [900, 560]);
  results[font] = await measure(font);
}
writeFileSync(`${outDir}/${variant}-measurements.json`, JSON.stringify(results, null, 2));
console.log(variant, JSON.stringify(results, null, 2));
await browser.close();
