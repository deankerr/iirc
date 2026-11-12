import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

/** The packages of the fonts `src/theme/fonts.css` declares, each with its licence. */
const fontPackages = [
  "@fontsource-variable/atkinson-hyperlegible-mono",
  "@fontsource-variable/jetbrains-mono",
  "@fontsource-variable/source-code-pro",
  "@fontsource/commit-mono",
  "@fontsource/ibm-plex-mono",
];

/**
 * Ships each font's licence beside it, as the SIL Open Font License asks of a copy of the
 * fonts, as `licences/<font>.txt`.
 * @returns The plugin.
 */
const fontLicences = (): Plugin => ({
  generateBundle() {
    const require = createRequire(import.meta.url);

    for (const name of fontPackages) {
      this.emitFile({
        fileName: `licences/${name.split("/")[1] ?? name}.txt`,
        source: readFileSync(require.resolve(`${name}/LICENSE`), "utf-8"),
        type: "asset",
      });
    }
  },
  name: "iirc-font-licences",
});

// In development the dev server proxies `/api` to a Daemon on its default address, so the
// browser sees one origin, as it does in every shape the Daemon serves (ADR 0007).
const daemon = "http://127.0.0.1:7667";

export default defineConfig({
  build: {
    // A font is always a file of the page's own, never inlined as a `data:` URL, which
    // `font-src 'self'` refuses, and which every page would carry whether drawn with or not.
    assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined),
  },
  plugins: [react(), fontLicences()],
  server: {
    proxy: {
      "/api": {
        // The browser's Host and Origin pass through unchanged, so the Daemon sees the
        // request as same-origin.
        changeOrigin: false,
        configure: (proxy) => {
          // A Daemon that is not running is a gateway's 502, which the Frontend reads
          // as no answer, rather than the proxy's bare 500.
          proxy.on("error", (_error, _request, response) => {
            if ("writeHead" in response && !response.headersSent) {
              response.writeHead(502).end();
            }
          });
        },
        target: daemon,
      },
    },
  },
  // The theme reader's Worker is a module of its own, in `assets/`, from the page's origin.
  worker: { format: "es" },
});
