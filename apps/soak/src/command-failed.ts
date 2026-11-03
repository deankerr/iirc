import { Console, Data, Effect, Runtime } from "effect";

/**
 * Why a command did not do what it was asked, already in words for the Owner. It carries
 * its own exit code and is printed once, on stderr, so that stdout holds only the
 * summaries a journal is meant to keep.
 */
export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly exitCode: number;
  readonly message: string;
}> {
  override readonly [Runtime.errorReported] = false;

  /**
   * The exit code the runtime ends with.
   * @returns The refusal's own.
   */
  override get [Runtime.errorExitCode]() {
    return this.exitCode;
  }
}

/** The exit code of a command run wrongly, such as with no key. */
export const usageExitCode = 2;

/** The exit code of a check that ran and found the soak test failing. */
export const verdictExitCode = 1;

/** The exit code of a command that could not do its work, such as reaching a Daemon. */
export const unableExitCode = 3;

/**
 * A refusal, in words that say what to do about it.
 * @param message - What went wrong.
 * @param exitCode - Which of the exit codes above.
 * @returns The refusal.
 */
export const failed = (message: string, exitCode: number) =>
  new CommandFailed({ exitCode, message });

/**
 * Prints a refusal once, plainly, on stderr, and lets its exit code follow.
 * @param command - The command.
 * @returns The same command.
 */
export const reportedOnStderr = <A, R>(command: Effect.Effect<A, CommandFailed, R>) =>
  Effect.tapError(command, ({ message }) => Console.error(message));
