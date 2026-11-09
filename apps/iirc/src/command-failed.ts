/**
 * Refusals in words for the Owner, printed once on stderr, so stdout holds only what a
 * command was asked for, such as a key.
 *
 * @packageDocumentation
 */
import { Console, Data, Effect, Runtime } from "effect";

/** Why a command did not do what it was asked, already in words, with its exit code. */
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
 * @returns The refusal, which exits 1.
 */
export const failed = (message: string) => new CommandFailed({ exitCode: 1, message });

/**
 * Prints a refusal once, plainly, on stderr, and lets its exit code follow.
 * @param command - The command.
 * @returns The same command.
 */
export const reportedOnStderr = <A, R>(command: Effect.Effect<A, CommandFailed, R>) =>
  Effect.tapError(command, ({ message }) => Console.error(message));
