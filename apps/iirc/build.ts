/**
 * Compiles `iirc` into one executable, with the built web frontend inside unless `--no-web`
 * is given (ADR 0007: a build flag only decides whether web assets are included).
 *
 * ```sh
 * bun apps/iirc/build.ts                          # dist/iirc, with apps/web/dist inside
 * bun apps/iirc/build.ts --no-web                 # dist/iirc-no-web, without it
 * bun apps/iirc/build.ts --outfile /tmp/iirc      # anywhere else
 * ```
 *
 * The web frontend must be built first, with `bun run build:web`. Bun embeds a directory
 * under its own name, so `apps/web/dist` is read back as `dist` beside the program, which is
 * what `src/web.ts` looks for.
 *
 * @packageDocumentation
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { compile } from "./compile.ts";

const repository = path.join(import.meta.dir, "..", "..");
const web = path.join(repository, "apps", "web", "dist");

const { values } = parseArgs({
  options: {
    "no-web": { default: false, type: "boolean" },
    outfile: { type: "string" },
  },
  strict: true,
});

const withWeb = !values["no-web"];

const outfile = path.resolve(
  values.outfile ?? path.join(repository, "dist", withWeb ? "iirc" : "iirc-no-web")
);

if (withWeb && !existsSync(path.join(web, "index.html"))) {
  process.stderr.write(`${web} holds no built web frontend. Run bun run build:web first.\n`);
  process.exit(1);
}

const failures = await compile(
  path.join(import.meta.dir, "src", "main.ts"),
  outfile,
  withWeb ? [web] : []
);

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${outfile}${withWeb ? ", with the web frontend" : ""}\n`);
