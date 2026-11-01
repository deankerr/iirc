import { assert, describe, it } from "@effect/vitest";

import * as Log from "./log.ts";

describe("log placeholder", () => {
  it("loads, until real tests replace this one", () => {
    assert.isDefined(Log);
  });
});
