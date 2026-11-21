// Probe: in real Chromium, which rows of a 600px scroller the Previews' observer tells of
// before any scroll: with the scroller as root and a 100% margin (as built), and with the
// page's viewport as root and the same margin (the clipped case the root avoids).
const root = process.argv[2];
const { chromium } = await import(Bun.resolveSync("playwright", `${root}/apps/iirc`));
const { readFileSync } = await import("node:fs");
const watchNear = readFileSync(`${root}/apps/web/src/previews/near-view.ts`, "utf8")
  .split("export const watchNear = ")[1]
  .replace(/\(\s*element: Element \| null,\s*root: Element \| null,\s*near: \(\) => void\s*\): \(\(\) => void\) =>/u, "(element, root, near) =>");

const page = `<!doctype html><style>
body{margin:0;font:14px monospace;background:#111;color:#ccc}
.log{height:600px;overflow:auto;border:2px solid #555;width:420px}
.row{height:40px;box-sizing:border-box;border-bottom:1px solid #333;padding:10px}
.asked{background:#1d4d2b;color:#fff}
</style><div class=log id=log></div><script>
const watchNear = ${watchNear};
const log = document.getElementById("log");
for (let i = 0; i < 60; i++) {
  const row = document.createElement("div");
  row.className = "row";
  row.textContent = "row " + i + " (top " + i * 40 + "px)";
  log.append(row);
  watchNear(row, MODE === "viewport" ? null : log, () => { row.classList.add("asked"); row.textContent += "  asked"; });
}
</script>`;

const browser = await chromium.launch();
for (const mode of ["scroller", "viewport"]) {
  const tab = await browser.newPage({ viewport: { height: 2000, width: 460 } });
  await tab.setContent(page.replace("<script>", `<script>const MODE = "${mode}";`));
  await tab.waitForTimeout(300);
  const asked = await tab.$$eval(".asked", (rows) => rows.length);
  console.log(`root ${mode}: ${asked} of 60 rows asked; rows 0-14 are in the 600px view, 15-29 the screen below it`);
  if (mode === "scroller") {
    await tab.evaluate(() => document.getElementById("log").scrollTo(0, 400));
    await tab.waitForTimeout(200);
    await tab.screenshot({ path: process.argv[3], clip: { height: 610, width: 430, x: 0, y: 0 } });
  }
  await tab.close();
}
await browser.close();
