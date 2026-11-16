/**
 * The `meta` box of a HEIC or AVIF image: the items of the image kept, and every other item,
 * Exif and XMP among them, dropped with its data.
 *
 * `meta` is rewritten to hold only what a keep-list names, and what that frees is a `free`
 * box right after it, so that `meta` and it are exactly as long as `meta` was and every
 * offset in `iloc`, which is absolute, is still right. A dropped item is taken out of every
 * box that names it, and its data is zeroed where it lies.
 *
 * @packageDocumentation
 */
import { Unreadable, bad, readBoxes, typeOf, typesOf } from "./boxes.ts";
import type { Box, Patch } from "./boxes.ts";
import {
  ascii,
  be,
  concat,
  copy,
  hasFlag,
  makeWriter,
  patch,
  put,
  readBe,
  reserve,
  written,
} from "./bytes.ts";
import type { Writer } from "./bytes.ts";
import { readItems, readLocations, zeroing } from "./items.ts";
import type { Items, Locations, Range, Zeroing } from "./items.ts";

export type { Range } from "./items.ts";

// What an image needs to be decoded and shown: its codec's configuration, size, colour,
// orientation and cropping, and what a gain map or alpha is made of.
const keptProperties = typesOf(
  "hvcC av1C avcC vvcC jpgC j2kH uncC cmpd mskC ispe colr irot imir pixi clap auxC pasp lsel a1op a1lx clli mdcv cclv amve rloc iscl"
);

const free = ascii("free");

const pict = readBe(ascii("pict"), 0, 4);

const metaType = typeOf("meta");

const types = {
  dinf: typeOf("dinf"),
  hdlr: typeOf("hdlr"),
  idat: typeOf("idat"),
  iinf: typeOf("iinf"),
  iloc: typeOf("iloc"),
  ipco: typeOf("ipco"),
  ipma: typeOf("ipma"),
  iprp: typeOf("iprp"),
  iref: typeOf("iref"),
  pitm: typeOf("pitm"),
};

type Single = "dinf" | "hdlr" | "idat" | "iinf" | "iloc" | "iprp" | "iref" | "pitm";

const singleNames: readonly Single[] = [
  "dinf",
  "hdlr",
  "idat",
  "iinf",
  "iloc",
  "iprp",
  "iref",
  "pitm",
];

type Parts = Readonly<Record<Single, Box | undefined>>;

// The one of each box a `meta` may have, or a failure for a `meta` with two of one.
const singles = (children: readonly Box[]): Parts | Unreadable => {
  const parts: Record<Single, Box | undefined> = {
    dinf: undefined,
    hdlr: undefined,
    idat: undefined,
    iinf: undefined,
    iloc: undefined,
    iprp: undefined,
    iref: undefined,
    pitm: undefined,
  };

  for (const name of singleNames) {
    const found = children.filter((child) => child.type === types[name]);

    if (found.length > 1) {
      return bad(`more than one ${name} in a meta`);
    }

    [parts[name]] = found;
  }

  return parts;
};

// A box begun in the output, which is given its size once it is whole.
const open = (out: Writer, bytes: Uint8Array, box: Box): number => {
  const at = out.length;

  copy(out, bytes, box.start, box.start + box.header);

  return at;
};

const close = (out: Writer, at: number, header: number) => {
  const size = out.length - at;

  patch(out, header === 16 ? at + 8 : at, header === 16 ? be(size, 8) : be(size, 4));
};

// Where a box's payload begins.
const payloadAt = (box: Box) => box.start + box.header;

// `ipma` without the associations of dropped items. A kept item that needs, by an essential
// association, a property that is retyped could not be decoded, so that is a failure.
const rebuildAssociations = (
  bytes: Uint8Array,
  out: Writer,
  ipma: Box,
  kept: ReadonlySet<number>,
  retyped: ReadonlySet<number>
): Unreadable | null => {
  const p = payloadAt(ipma);

  if (p + 8 > ipma.end) {
    return bad("an ipma is cut short");
  }

  const idWidth = (bytes[p] ?? 0) < 1 ? 2 : 4;
  const indexWidth = hasFlag(bytes[p + 3] ?? 0, 1) ? 2 : 1;
  const count = readBe(bytes, p + 4, 4);
  const entries: Range[] = [];
  let at = p + 8;

  for (let n = 0; n < count; n += 1) {
    const end = at + idWidth + 1 + (bytes[at + idWidth] ?? 0) * indexWidth;

    if (end > ipma.end) {
      return bad("an ipma entry is cut short");
    }

    if (kept.has(readBe(bytes, at, idWidth))) {
      for (let i = at + idWidth + 1; i < end; i += indexWidth) {
        const association = readBe(bytes, i, indexWidth);
        const essential = hasFlag(bytes[i] ?? 0, 128);
        const index = association - (essential ? 128 * 256 ** (indexWidth - 1) : 0);

        if (essential && retyped.has(index)) {
          return bad("a kept item needs a property that is dropped");
        }
      }

      entries.push({ end, start: at });
    }

    at = end;
  }

  if (at !== ipma.end) {
    return bad("an ipma has more than its count of entries");
  }

  const begin = open(out, bytes, ipma);

  copy(out, bytes, p, p + 4);
  put(out, be(entries.length, 4));

  for (const { end, start } of entries) {
    copy(out, bytes, start, end);
  }

  close(out, begin, ipma.header);

  return null;
};

// `ipco` as it was, with every property not on the keep-list retyped `free` and zeroed where it
// is. Indices in `ipma` count the properties, so one is emptied, not taken out.
const rebuildProperties = (bytes: Uint8Array, out: Writer, ipco: Box): Unreadable | null => {
  const properties = readBoxes(bytes, payloadAt(ipco), ipco.end);

  if (properties instanceof Unreadable) {
    return properties;
  }

  const begin = open(out, bytes, ipco);

  for (const property of properties) {
    if (keptProperties.has(property.type)) {
      copy(out, bytes, property.start, property.end);
    } else {
      const at = open(out, bytes, property);

      patch(out, at + 4, free);
      reserve(out, property.end - property.start - property.header);
    }
  }

  close(out, begin, ipco.header);

  return null;
};

// The 1-based indices of the properties of `ipco` that are retyped.
const retypedIndices = (
  bytes: Uint8Array,
  ipco: Box | undefined
): ReadonlySet<number> | Unreadable => {
  if (ipco === undefined) {
    return new Set();
  }

  const properties = readBoxes(bytes, payloadAt(ipco), ipco.end);

  if (properties instanceof Unreadable) {
    return properties;
  }

  return new Set(
    properties.flatMap((property, i) => (keptProperties.has(property.type) ? [] : [i + 1]))
  );
};

// `iprp` with `ipco` as above and `ipma` without dropped items; anything else in it is dropped.
const rebuildPropertyBox = (
  bytes: Uint8Array,
  out: Writer,
  iprp: Box,
  kept: ReadonlySet<number>
): Unreadable | null => {
  const children = readBoxes(bytes, payloadAt(iprp), iprp.end);

  if (children instanceof Unreadable) {
    return children;
  }

  const ipcos = children.filter((child) => child.type === types.ipco);

  if (ipcos.length > 1) {
    return bad("more than one ipco in an iprp");
  }

  const retyped = retypedIndices(bytes, ipcos[0]);

  if (retyped instanceof Unreadable) {
    return retyped;
  }

  const begin = open(out, bytes, iprp);

  for (const child of children) {
    let failure: Unreadable | null = null;

    if (child.type === types.ipco) {
      failure = rebuildProperties(bytes, out, child);
    } else if (child.type === types.ipma) {
      failure = rebuildAssociations(bytes, out, child, kept, retyped);
    }

    if (failure !== null) {
      return failure;
    }
  }

  close(out, begin, iprp.header);

  return null;
};

// Whether a reference from a kept item is whole, and to kept items only.
const referencesKept = (
  bytes: Uint8Array,
  reference: Box,
  idWidth: number,
  kept: ReadonlySet<number>
): Unreadable | null => {
  const q = payloadAt(reference);

  if (q + idWidth + 2 > reference.end) {
    return bad("an iref reference is cut short");
  }

  const count = readBe(bytes, q + idWidth, 2);

  if (q + idWidth + 2 + count * idWidth > reference.end) {
    return bad("an iref reference is cut short");
  }

  for (let n = 0; n < count; n += 1) {
    if (!kept.has(readBe(bytes, q + idWidth + 2 + n * idWidth, idWidth))) {
      return bad("a kept item refers to a dropped item");
    }
  }

  return null;
};

// `iref` without the references that dropped items make, and a failure if a kept item refers
// to one.
const rebuildReferences = (
  bytes: Uint8Array,
  out: Writer,
  iref: Box,
  kept: ReadonlySet<number>
): Unreadable | null => {
  const p = payloadAt(iref);
  const version = bytes[p] ?? 0;

  if (p + 4 > iref.end || version > 1) {
    return bad("an iref is cut short, or of a version unknown");
  }

  const idWidth = version === 0 ? 2 : 4;
  const references = readBoxes(bytes, p + 4, iref.end);

  if (references instanceof Unreadable) {
    return references;
  }

  const begin = open(out, bytes, iref);

  copy(out, bytes, p, p + 4);

  for (const reference of references) {
    if (payloadAt(reference) + idWidth > reference.end) {
      return bad("an iref reference is cut short");
    }

    if (kept.has(readBe(bytes, payloadAt(reference), idWidth))) {
      const failure = referencesKept(bytes, reference, idWidth, kept);

      if (failure !== null) {
        return failure;
      }

      copy(out, bytes, reference.start, reference.end);
    }
  }

  close(out, begin, iref.header);

  return null;
};

// `iinf` with the kept `infe` boxes only, and their count.
const rebuildItemInfo = (bytes: Uint8Array, out: Writer, iinf: Box, items: Items) => {
  const p = payloadAt(iinf);
  const countWidth = (bytes[p] ?? 0) === 0 ? 2 : 4;
  const begin = open(out, bytes, iinf);

  copy(out, bytes, p, p + 4);
  put(out, be(items.infos.length, countWidth));

  for (const info of items.infos) {
    copy(out, bytes, info.start, info.end);
  }

  close(out, begin, iinf.header);
};

// `iloc` with the entries of kept items only, and their count.
const rebuildLocations = (
  bytes: Uint8Array,
  out: Writer,
  iloc: Box,
  locations: Locations,
  kept: ReadonlySet<number>
) => {
  const begin = open(out, bytes, iloc);
  const entries = locations.entries.filter(({ id }) => kept.has(id));

  copy(out, bytes, payloadAt(iloc), locations.countAt);
  put(out, be(entries.length, locations.countWidth));

  for (const { span } of entries) {
    copy(out, bytes, span.start, span.end);
  }

  close(out, begin, iloc.header);
};

// `idat` as it was, with the data of dropped items zeroed in it.
const rebuildItemData = (bytes: Uint8Array, out: Writer, idat: Box, zeros: Zeroing) => {
  const at = out.length;

  copy(out, bytes, idat.start, idat.end);

  for (const { end, start } of zeros.idat) {
    out.bytes.fill(0, at + idat.header + start, at + idat.header + end);
  }
};

// Whether `pitm` names an item that is kept.
const primaryIsKept = (bytes: Uint8Array, pitm: Box, kept: ReadonlySet<number>): boolean => {
  const p = payloadAt(pitm);
  const idWidth = (bytes[p] ?? 0) === 0 ? 2 : 4;

  return p + 4 + idWidth <= pitm.end && kept.has(readBe(bytes, p + 4, idWidth));
};

/** What a `meta` is rebuilt from: what it holds, and what of it is kept. */
interface Rebuild {
  readonly parts: Parts;
  readonly items: Items;
  readonly locations: Locations | undefined;
  readonly zeros: Zeroing;
}

// Writes one child of `meta` as it is kept: copied, rebuilt, or not at all.
const rebuildChild = (
  bytes: Uint8Array,
  out: Writer,
  child: Box,
  { items, locations, parts, zeros }: Rebuild
): Unreadable | null => {
  if (child === parts.hdlr || child === parts.dinf || child === parts.pitm) {
    copy(out, bytes, child.start, child.end);
  } else if (child === parts.iinf) {
    rebuildItemInfo(bytes, out, child, items);
  } else if (child === parts.iloc && locations !== undefined) {
    rebuildLocations(bytes, out, child, locations, items.kept);
  } else if (child === parts.iref) {
    return rebuildReferences(bytes, out, child, items.kept);
  } else if (child === parts.iprp) {
    return rebuildPropertyBox(bytes, out, child, items.kept);
  } else if (child === parts.idat) {
    rebuildItemData(bytes, out, child, zeros);
  }

  return null;
};

/** Where the file's own boxes are, which a `meta` is checked against. */
export interface File {
  readonly size: number;
  /** The payloads of its `mdat` boxes, in order. */
  readonly mdats: readonly Range[];
}

// Reads what a `meta` holds and decides what of it is kept.
const decide = (
  bytes: Uint8Array,
  base: number,
  children: readonly Box[],
  file: File
): Rebuild | Unreadable => {
  const parts = singles(children);

  if (parts instanceof Unreadable) {
    return parts;
  }

  const { hdlr, idat, iinf, iloc, pitm } = parts;

  if (
    hdlr === undefined ||
    hdlr.end - payloadAt(hdlr) < 12 ||
    readBe(bytes, payloadAt(hdlr) + 8, 4) !== pict
  ) {
    return bad("a meta that does not hold a picture");
  }

  const items =
    iinf === undefined
      ? { infos: [], kept: new Set<number>(), listed: new Set<number>() }
      : readItems(bytes, iinf);

  if (items instanceof Unreadable) {
    return items;
  }

  if (pitm !== undefined && !primaryIsKept(bytes, pitm, items.kept)) {
    return bad("the primary item is dropped or missing");
  }

  const locations = iloc === undefined ? undefined : readLocations(bytes, iloc);

  if (locations instanceof Unreadable) {
    return locations;
  }

  // A dropped item must be found in iloc, or where its data is cannot be proved.
  const located = new Set((locations?.entries ?? []).map(({ id }) => id));

  for (const id of items.listed) {
    if (!items.kept.has(id) && !located.has(id)) {
      return bad("an item is listed in iinf and not located in iloc");
    }
  }

  const zeros = zeroing(locations?.entries ?? [], items.kept, {
    fileSize: file.size,
    idat: idat === undefined ? undefined : { end: idat.end, start: payloadAt(idat) },
    mdats: file.mdats,
    meta: { end: base + bytes.length, start: base },
  });

  return zeros instanceof Unreadable ? zeros : { items, locations, parts, zeros };
};

/**
 * Plans the stripping of a HEIC or AVIF's top-level `meta`.
 * @param bytes - The `meta` box, header and all.
 * @param base - Where it begins in the file, which the patches are given in.
 * @param header - How long its header is.
 * @param file - How long the file is, and where its `mdat` boxes are.
 * @returns The patches, or why it could not be walked.
 */
export const walkMeta = (
  bytes: Uint8Array,
  base: number,
  header: number,
  file: File
): readonly Patch[] | Unreadable => {
  if (header + 4 > bytes.length) {
    return bad("a meta is cut short");
  }

  const children = readBoxes(bytes, header + 4, bytes.length);

  if (children instanceof Unreadable) {
    return children;
  }

  const rebuild = decide(bytes, base, children, file);

  if (rebuild instanceof Unreadable) {
    return rebuild;
  }

  // Never more than `meta` was: each part is copied whole, or less, and a count is as wide as it was.
  const out = makeWriter(bytes.length);
  const begin = open(out, bytes, { end: bytes.length, header, start: 0, type: metaType });

  copy(out, bytes, header, header + 4);

  for (const child of children) {
    const failure = rebuildChild(bytes, out, child, rebuild);

    if (failure !== null) {
      return failure;
    }
  }

  close(out, begin, header);

  // What `meta` gave up is a `free` box, so that everything after `meta` stays where it was.
  const rest = bytes.length - out.length;

  if (rest > 0 && rest < 8) {
    return bad("a meta that shrinks too little to hold a free box");
  }

  const patches: Patch[] = [{ at: base, bytes: written(out) }];

  if (rest > 0) {
    patches.push({ at: base + out.length, bytes: concat([be(rest, 4), free]) });
  }

  if (rest > 8) {
    patches.push({ at: base + out.length + 8, zeros: rest - 8 });
  }

  for (const { end, start } of rebuild.zeros.file) {
    patches.push({ at: start, zeros: end - start });
  }

  return patches;
};
