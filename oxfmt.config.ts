import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Vendored skills and their lockfile are `npx skills`'s, which checks them by hash.
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), ".agents/skills/**", "skills-lock.json"],
  printWidth: 100,
});
