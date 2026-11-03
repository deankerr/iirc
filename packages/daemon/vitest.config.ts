import { defineConfig } from "vitest/config";

import { realWork } from "../../vitest.shared.config.ts";

export default defineConfig({ test: realWork });
