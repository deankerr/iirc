# Effect wins where it overlaps Bun

Where Effect and Bun both offer a way to do something, we use Effect's. Its errors are typed, interruption reaches every resource it holds, and its services can be replaced in a test, so code written that way fails, stops, and is tested the same way everywhere. Bun's own APIs each bring their own errors and cleanup. Bun remains our runtime and build tool, and we use it directly for what Effect does not offer.

## Consequences

- Before reaching for a Bun API, check whether Effect has the same capability. If it does, use Effect's, or say in the code why it falls short for this use.
- A use of Bun that once filled a gap in Effect is worth revisiting when Effect fills it.
- This is a preference, not a ban: tests and tools may use Bun directly where that is simpler.
