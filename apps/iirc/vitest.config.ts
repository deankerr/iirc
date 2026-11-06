import { defineConfig } from "vitest/config";

import { realWork } from "../../vitest.shared.config.ts";

// `globalSetup` builds the binary that `src/binary.ts` calls `testBinary`, once per run.
export default defineConfig({ test: { ...realWork, globalSetup: ["./src/global-setup.ts"] } });
