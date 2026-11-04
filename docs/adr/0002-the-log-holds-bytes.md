# The Log holds bytes

A Line Entry stores the bytes that crossed the Connection, and everything else, including parsed Lines, Messages, and Channel state, is derived from them. A parsed or decoded form would be simpler to query, but it freezes today's parser and encoding guesses into history. Keeping bytes means a parser fix also repairs old history, and any derived table can be deleted and rebuilt.

## Consequences

Every read of history pays for a fold or a derived table, so derived tables are part of the design and not an optimisation. Redaction is the only exception to keeping bytes exactly. Line order and durability must be settled before anything acts on a Line, so an append comes first, always. Effect's `EventLog` is not used, because it can give neither one gapless sequence for the whole Log (LOG-1) nor the bytes themselves (LOG-3).
