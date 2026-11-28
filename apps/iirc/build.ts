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
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

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

const built = await Bun.build({
  compile: {
    assets: withWeb ? [web] : [],
    // What it does comes from its arguments and its data directory alone, never from a
    // `.env`, `bunfig.toml`, `package.json`, or `tsconfig.json` where it happens to start.
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
    outfile,
  },
  entrypoints: [path.join(import.meta.dir, "src", "main.ts")],
  // The executable carries its own source map, compressed, so a stack trace in the log names
  // the source. The copy Bun also writes beside it is not needed.
  sourcemap: "linked",
});

rmSync(`${outfile}.map`, { force: true });

if (!built.success) {
  process.stderr.write(`${built.logs.map((log) => log.message).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`${outfile}${withWeb ? ", with the web frontend" : ""}\n`);
