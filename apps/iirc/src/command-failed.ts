import { Console, Data, Effect, Predicate, Runtime } from "effect";

/**
 * Why a command did not do what it was asked, already in words for the Owner. It carries
 * its own exit code, and is printed once, on stderr, rather than logged with a trace, so
 * that stdout holds only what a command was asked for, such as a key (AUTH-4).
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

/**
 * A refusal, in words that say what to do about it.
 * @param message - What went wrong.
 * @param exitCode - 1, or 2 for a command run wrongly.
 * @returns The refusal.
 */
export const failed = (message: string, exitCode = 1) => new CommandFailed({ exitCode, message });

/**
 * What a cause says of itself, on one line.
 * @param cause - Anything thrown or failed with.
 * @returns Its message if it has one, or else how it prints.
 */
export const described = (cause: unknown): string => {
  const text =
    Predicate.hasProperty(cause, "message") &&
    Predicate.isString(cause.message) &&
    cause.message !== ""
      ? cause.message
      : String(cause);

  return text.replaceAll(/\s*\n\s*/gu, " ").trim();
};

/**
 * Prints a refusal once, plainly, on stderr, and lets its exit code follow.
 * @param command - The command.
 * @returns The same command.
 */
export const reportedOnStderr = <A, R>(command: Effect.Effect<A, CommandFailed, R>) =>
  Effect.tapError(command, ({ message }) => Console.error(message));
