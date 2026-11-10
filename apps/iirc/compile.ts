/**
 * How `iirc` is compiled into one executable, shared by `build.ts` and the end-to-end run, so
 * what the run checks of an executable is what the build makes.
 *
 * @packageDocumentation
 */
import { rmSync } from "node:fs";

/**
 * Compiles an entry point into one executable for this machine.
 * @param entrypoint - The program, such as `src/main.ts`.
 * @param outfile - Where the executable goes.
 * @param assets - Directories to embed under their own names, such as `apps/web/dist`.
 * @returns Why it failed, as lines, or nothing.
 */
export const compile = async (
  entrypoint: string,
  outfile: string,
  assets: readonly string[]
): Promise<readonly string[]> => {
  const built = await Bun.build({
    compile: {
      assets: [...assets],
      // What it does comes from its arguments and its data directory alone, never from a
      // `.env`, `bunfig.toml`, `package.json`, or `tsconfig.json` where it happens to start.
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadPackageJson: false,
      autoloadTsconfig: false,
      outfile,
    },
    entrypoints: [entrypoint],
    // The executable carries its own source map, compressed, so a stack trace in the log
    // names the source. The copy Bun also writes beside it is not needed.
    sourcemap: "linked",
  });

  rmSync(`${outfile}.map`, { force: true });

  return built.success ? [] : built.logs.map((log) => log.message);
};
