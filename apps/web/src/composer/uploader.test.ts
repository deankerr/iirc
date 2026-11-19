import { describe, expect, it } from "vitest";

import { answerOf } from "./uploader.ts";

describe("what the Daemon's answer to a file sent says", () => {
  it("reads StoreFull from its Schema, with the limit, whatever the status's text", () => {
    expect(
      answerOf({ body: JSON.stringify({ _tag: "StoreFull", maxTotal: 1024 }), status: 507 })
    ).toStrictEqual({ _tag: "Failed", failure: { _tag: "StoreFull", maxTotal: 1024 } });
  });
});
