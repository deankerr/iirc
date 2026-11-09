/**
 * Plain data, as the Client's State must be: strings, numbers, booleans, `null`,
 * `undefined`, arrays, plain objects, `Map`, and `Set`. `impurity` walks a value and
 * names the first part that is not, `canonical` writes one as text that two processes
 * can compare, order included, and `difference` shows where two values part.
 *
 * @packageDocumentation
 */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-object-parameters -- This module is the check that reads an arbitrary value, such as a Client's opaque State, and says whether it is plain data. Its input is unknown by design. */

/**
 * Whether an object is a plain one, made by a literal or with a null prototype.
 * @param value - The object.
 * @returns Whether it is plain.
 */
const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

const keyText = (key: unknown): string =>
  typeof key === "string" ? JSON.stringify(key) : String(key);

const className = (value: object): string => {
  const name: unknown = value.constructor?.name;

  return typeof name === "string" && name !== "" ? name : "a class";
};

/** One part of a value, with what to call it. */
type Part = readonly [at: string, part: unknown];

// The parts of an array, a Map, a Set, or a plain object, or what is wrong with it.
const partsOf = (value: object, at: string): readonly Part[] | string => {
  if (Array.isArray(value)) {
    return Object.getPrototypeOf(value) === Array.prototype
      ? value.map((item: unknown, index): Part => [`${at}[${index}]`, item])
      : `${at} is a subclass of Array`;
  }

  if (value instanceof Map) {
    return Object.getPrototypeOf(value) === Map.prototype
      ? [...value].flatMap(([key, item]: readonly [unknown, unknown]): readonly Part[] => [
          [`${at} key ${keyText(key)}`, key],
          [`${at}.get(${keyText(key)})`, item],
        ])
      : `${at} is a subclass of Map`;
  }

  if (value instanceof Set) {
    return Object.getPrototypeOf(value) === Set.prototype
      ? [...value].map((item: unknown, index): Part => [`${at} item ${index}`, item])
      : `${at} is a subclass of Set`;
  }

  if (!isPlainObject(value)) {
    return `${at} is an instance of ${className(value)}`;
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return `${at} has a symbol key`;
  }

  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value));
  const accessor = descriptors.find(([, descriptor]) => !("value" in descriptor));

  return accessor === undefined
    ? descriptors.map(([key, descriptor]): Part => [`${at}.${key}`, descriptor.value])
    : `${at}.${accessor[0]} is a getter`;
};

const isLeaf = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/**
 * Finds the first part of a value that is not plain data.
 * @param value - The value, such as a Client's State.
 * @param path - What to call the value in the answer.
 * @returns Where the first impure part is and what it is, or `undefined` if it is all plain.
 */
export const impurity = (value: unknown, path = "state"): string | undefined => {
  // The objects on the way down, to find a cycle.
  const open = new Set<object>();

  const walk = (part: unknown, at: string): string | undefined => {
    if (isLeaf(part)) {
      return undefined;
    }

    if (typeof part !== "object" || part === null) {
      return `${at} is a ${typeof part}`;
    }

    if (open.has(part)) {
      return `${at} is a cycle`;
    }

    const parts = partsOf(part, at);

    if (typeof parts === "string") {
      return parts;
    }

    open.add(part);
    let found: string | undefined;

    for (const [where, inner] of parts) {
      found ??= walk(inner, where);
    }

    open.delete(part);

    return found;
  };

  return walk(value, path);
};

const leafText = (value: unknown): string => {
  switch (typeof value) {
    case "undefined": {
      return "undefined";
    }

    case "number": {
      return Object.is(value, -0) ? "-0" : String(value);
    }

    case "bigint": {
      return `${value}n`;
    }

    case "string":
    case "boolean": {
      return JSON.stringify(value);
    }

    case "symbol": {
      return value.toString();
    }

    case "function": {
      return "function";
    }

    case "object": {
      return "null";
    }

    default: {
      return "unknown";
    }
  }
};

/**
 * Writes plain data as text that is the same for the same value in any process, so two
 * values can be compared, or digested, in order. A `Map` and a `Set` keep their order,
 * and so do an object's keys. `Uint8Array`s, which only inputs hold, are written as
 * their bytes.
 * @param value - Plain data.
 * @returns Its canonical text.
 */
export const canonical = (value: unknown): string => {
  if (typeof value !== "object" || value === null) {
    return leafText(value);
  }

  if (value instanceof Uint8Array) {
    return `bytes[${[...value].join(",")}]`;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonical(item)).join(",")}]`;
  }

  if (value instanceof Map) {
    const entries = [...value].map(
      ([key, item]: readonly [unknown, unknown]) => `${canonical(key)}=>${canonical(item)}`
    );

    return `Map{${entries.join(",")}}`;
  }

  if (value instanceof Set) {
    return `Set{${[...value].map((item: unknown) => canonical(item)).join(",")}}`;
  }

  const entries = Object.entries(value).map(
    ([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`
  );

  return `{${entries.join(",")}}`;
};

/**
 * Shows where two values part, as their canonical text around the first difference.
 * @param left - One value, such as what was played.
 * @param right - The other, such as what was replayed.
 * @param names - What to call each.
 * @returns The two around where they part, or `undefined` if they are the same.
 */
export const difference = (
  left: unknown,
  right: unknown,
  names: readonly [string, string] = ["played  ", "replayed"]
): string | undefined => {
  const before = canonical(left);
  const after = canonical(right);

  if (before === after) {
    return undefined;
  }

  let index = 0;

  while (before[index] === after[index]) {
    index += 1;
  }

  const from = Math.max(0, index - 40);

  return `${names[0]} …${before.slice(from, index + 40)}…\n${names[1]} …${after.slice(from, index + 40)}…`;
};
