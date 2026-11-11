import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the dev server proxies `/api` to a Daemon on its default address, so the
// browser sees one origin, as it does in every shape the Daemon serves (ADR 0007).
const daemon = "http://127.0.0.1:7667";

export default defineConfig({
  plugins: [react()],
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
