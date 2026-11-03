import { writeFileSync } from "node:fs";

import { Effect } from "effect";

import { checkDeadline, inBudget } from "./budget.ts";
import { serveReader } from "./reader-server.ts";

// A reader whose every row costs what a row of a scan over a huge Log would, so that a
// test can hold a read open as long as it likes. The cost is spent where a real scan
// spends it: inside a statement, blocking the Worker, where only the budget stops it.

// What each row a statement looks at costs, which `reader.test.ts` counts on.
const rowMillis = 5;

// A file the test names, created when the first row is costed, so that the test knows a
// read is running and is not left to guess from the time it was sent.
const reading = process.env.IIRC_READING_MARKER;
let announced = false;

Effect.runFork(
  serveReader((database) => {
    database.function(inBudget, (deadline: number) => {
      if (!announced && reading !== undefined) {
        announced = true;
        writeFileSync(reading, "reading");
      }

      Bun.sleepSync(rowMillis);

      return checkDeadline(deadline);
    });
  })
);
