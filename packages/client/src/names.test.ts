import { describe, expect, it } from "vitest";

import { nickVectors } from "../../../fixtures/nicks/vectors.ts";
import { parseNick } from "./names.ts";

describe("reading a nick", () => {
  it("reads every shared vector as the vectors say the Client does", () => {
    const read = nickVectors.map((vector) => ({
      name: vector.name,
      nick: parseNick(vector, vector.name) !== undefined,
    }));

    expect(read).toStrictEqual(
      nickVectors.map((vector) => ({ name: vector.name, nick: vector.nick }))
    );
  });
});
