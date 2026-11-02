import { describe, expect, it } from "vitest";

import type { Key } from "./configuration.ts";
import { findKey, hashKey, newKey, reaches } from "./keys.ts";

const keyOf = (key: string, scope: Key["scope"] = "admin"): Key => ({
  created: 0,
  hash: hashKey(key),
  scope,
});

describe(newKey, () => {
  it("AUTH-2: is `iirc_` and 32 random bytes in base64url, never the same twice", () => {
    const keys = Array.from({ length: 50 }, newKey);

    for (const key of keys) {
      expect(key).toMatch(/^iirc_[A-Za-z0-9_-]{43}$/u);
      expect(Buffer.from(key.slice("iirc_".length), "base64url")).toHaveLength(32);
    }

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe(hashKey, () => {
  it("AUTH-2: is the key's SHA-256, in hex", () => {
    // What `printf iirc_test | sha256sum` says.
    expect(hashKey("iirc_test")).toBe(
      "5fc91a6706c6d679b4228723bcee429bea1916e837344032a054bf76d384d175"
    );
  });
});

describe(findKey, () => {
  const phone = newKey();
  const owner = newKey();

  const keys = new Map([
    ["owner", keyOf(owner)],
    ["phone", keyOf(phone, "chat")],
  ]);

  it("AUTH-2: finds whose key it is, with its scope", () => {
    expect(findKey(keys, phone)).toStrictEqual({ name: "phone", scope: "chat" });
    expect(findKey(keys, owner)).toStrictEqual({ name: "owner", scope: "admin" });
  });

  it("AUTH-2: finds nobody for a key one character off, or of another length, or empty", () => {
    const last = phone.at(-1) === "A" ? "B" : "A";

    expect(findKey(keys, `${phone.slice(0, -1)}${last}`)).toBeUndefined();
    expect(findKey(keys, `${phone}A`)).toBeUndefined();
    expect(findKey(keys, phone.slice(0, -1))).toBeUndefined();
    expect(findKey(keys, "")).toBeUndefined();
    expect(findKey(keys, hashKey(phone))).toBeUndefined();
  });

  it("finds nobody when there are no keys", () => {
    expect(findKey(new Map(), phone)).toBeUndefined();
  });
});

describe(reaches, () => {
  it("AUTH-3: gives each scope everything the one below it has", () => {
    const scopes = ["read", "chat", "admin"] as const;

    expect(scopes.map((scope) => scopes.filter((needed) => reaches(scope, needed)))).toStrictEqual([
      ["read"],
      ["read", "chat"],
      ["read", "chat", "admin"],
    ]);
  });
});
