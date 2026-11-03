/**
 * What a package's tests share when they do real work: SQLite on disk with `fsync`, Workers,
 * sockets, and Bun subprocesses. Not a vitest config itself, because vitest is a dependency
 * of the packages and not of the root.
 *
 * Measured on this machine, a test of this kind takes 0.3 to 3 seconds alone, and four to
 * ten times that while another suite, a build, or a reviewer's checks are running beside
 * it. Nothing in them is a speed requirement: a test that is one waits for a signal and
 * then compares times it measured itself (see `eventually`, and `TestClock` for policy).
 * So the timeout is there to end a test that hangs, and it is set well above anything a
 * busy machine takes, instead of to the speed of a quiet one.
 *
 * `maxWorkers` keeps a package's own files from competing with each other. A package's
 * wall time is that of its slowest file, so four workers cost nothing when the machine is
 * quiet, and when it is not, the files stop slowing each other and everything else.
 */
export const realWork = {
  hookTimeout: 60_000,
  maxWorkers: 4,
  testTimeout: 60_000,
} as const;
