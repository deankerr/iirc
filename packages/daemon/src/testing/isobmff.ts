/**
 * ISO base media files for tests: the fixtures of a phone's HEIC and AVIF photos and its MP4
 * and MOV videos, readers that take one apart independently of the walker so a test can say
 * what came out, and builders of small ones with exactly the parts a test is about.
 *
 * @packageDocumentation
 */
import { readFileSync } from "node:fs";

const utf8 = new TextEncoder();

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`media/${name}`, import.meta.url)));

/** An iPhone's HEIC photo: HEVC, a thumbnail, `irot`, `colr`, Exif with GPS, and XMP. */
export const photoHeic = fixture("photo.heic");

/** The same photo as AVIF. */
export const photoAvif = fixture("photo.avif");

/**
 * An H.264 and AAC MP4 with a location in `udta`, a title, an XMP `uuid` box, and a `mebx`
 * track of ISO 6709 locations, as a phone writes, whose samples are in a second `mdat`.
 */
export const clipMp4 = fixture("clip.mp4");

/**
 * A QuickTime movie with `com.apple.quicktime.location.ISO6709` in `keys`, XMP, and the same
 * `mebx` track of locations as the MP4.
 */
export const clipMov = fixture("clip.mov");

/**
 * Bytes, end to end.
 * @param parts - The parts.
 * @returns One array.
 */
export const cat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }

  return whole;
};

/**
 * A big-endian number.
 * @param value - The number.
 * @param width - How many bytes.
 * @returns The bytes.
 */
export const u = (value: number, width: number): Uint8Array =>
  Uint8Array.from({ length: width }, (_, i) => Math.floor(value / 256 ** (width - 1 - i)) % 256);

/**
 * Text as ASCII bytes.
 * @param value - The text.
 * @returns The bytes.
 */
export const text = (value: string): Uint8Array => Uint8Array.from(utf8.encode(value));

/**
 * A box.
 * @param type - Its four-character type.
 * @param parts - Its payload.
 * @returns The box.
 */
export const box = (type: string, ...parts: readonly Uint8Array[]): Uint8Array => {
  const payload = cat(...parts);

  return cat(u(payload.length + 8, 4), text(type), payload);
};

/**
 * A box with a 64-bit size.
 * @param type - Its type.
 * @param parts - Its payload.
 * @returns The box.
 */
export const largeBox = (type: string, ...parts: readonly Uint8Array[]): Uint8Array => {
  const payload = cat(...parts);

  return cat(u(1, 4), text(type), u(payload.length + 16, 8), payload);
};

/**
 * A box that runs to the end of the file.
 * @param type - Its type.
 * @param parts - Its payload.
 * @returns The box.
 */
export const toEndBox = (type: string, ...parts: readonly Uint8Array[]): Uint8Array =>
  cat(u(0, 4), text(type), ...parts);

/**
 * A box with a version and flags.
 * @param type - Its type.
 * @param version - The version.
 * @param flags - The flags.
 * @param parts - Its payload after them.
 * @returns The box.
 */
export const fullBox = (
  type: string,
  version: number,
  flags: number,
  ...parts: readonly Uint8Array[]
): Uint8Array => box(type, u(version, 1), u(flags, 3), ...parts);

/** A box as a reader sees it, where it is and how its header and payload lie. */
export interface Found {
  readonly type: string;
  readonly start: number;
  readonly header: number;
  readonly end: number;
}

/**
 * The boxes laid end to end in a range, read plainly: a size of 1 reads the 64-bit size
 * after the type, a size of 0 runs to the end of the range, and a box that does not fit
 * ends the reading.
 * @param bytes - The file.
 * @param from - Where the range begins.
 * @param to - Where it ends.
 * @returns The boxes.
 */
const boxesIn = (bytes: Uint8Array, from = 0, to = bytes.length): readonly Found[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Found[] = [];
  let at = from;

  while (at + 8 <= to) {
    const small = view.getUint32(at);
    const header = small === 1 ? 16 : 8;
    let size = small;

    if (small === 1) {
      size = Number(view.getBigUint64(at + 8));
    } else if (small === 0) {
      size = to - at;
    }

    if (size < header || at + size > to) {
      break;
    }

    found.push({
      end: at + size,
      header,
      start: at,
      type: String.fromCodePoint(...bytes.subarray(at + 4, at + 8)),
    });
    at += size;
  }

  return found;
};

/**
 * Where a box's children begin, for a box that holds boxes: after the version and flags of a
 * `meta` or an `iref`, and after those and the count of an `iinf`.
 * @param bytes - The file.
 * @param parent - The box.
 * @returns Where its first child would begin.
 */
const childrenFrom = (bytes: Uint8Array, parent: Found): number => {
  if (parent.type === "meta" || parent.type === "iref") {
    return parent.start + parent.header + 4;
  }

  if (parent.type === "iinf") {
    return parent.start + parent.header + (bytes[parent.start + parent.header] === 0 ? 6 : 8);
  }

  return parent.start + parent.header;
};

/**
 * The children of a box.
 * @param bytes - The file.
 * @param parent - The box.
 * @returns Them.
 */
export const childrenOf = (bytes: Uint8Array, parent: Found): readonly Found[] =>
  boxesIn(bytes, childrenFrom(bytes, parent), parent.end);

/**
 * The first box at the end of a path of types from the top of the file.
 * @param bytes - The file.
 * @param path - The types, outermost first.
 * @returns The box, or none.
 */
export const boxAt = (bytes: Uint8Array, ...path: readonly string[]): Found | undefined => {
  let found: Found | undefined;
  let children = boxesIn(bytes);

  for (const type of path) {
    found = children.find((child) => child.type === type);

    if (found === undefined) {
      return undefined;
    }

    children = childrenOf(bytes, found);
  }

  return found;
};

/**
 * Every type on the way down the file, outermost and in order, as `a/b/c` paths.
 * @param bytes - The file.
 * @param within - The types that are walked into.
 * @returns The paths.
 */
export const pathsOf = (bytes: Uint8Array, within: ReadonlySet<string>): readonly string[] => {
  const out: string[] = [];

  const walk = (children: readonly Found[], prefix: string) => {
    for (const child of children) {
      out.push(`${prefix}${child.type}`);

      if (within.has(child.type)) {
        walk(childrenOf(bytes, child), `${prefix}${child.type}/`);
      }
    }
  };

  walk(boxesIn(bytes), "");

  return out;
};

/**
 * The payload of a box.
 * @param bytes - The file.
 * @param found - The box.
 * @returns Its bytes, after its header.
 */
export const payloadOf = (bytes: Uint8Array, found: Found): Uint8Array =>
  bytes.subarray(found.start + found.header, found.end);

const be = (bytes: Uint8Array, at: number, width: number) => {
  let value = 0;

  for (let i = 0; i < width; i += 1) {
    value = value * 256 + (bytes[at + i] ?? 0);
  }

  return value;
};

const fourCC = (bytes: Uint8Array, at: number) =>
  String.fromCodePoint(...bytes.subarray(at, at + 4));

/** An item of a HEIF file as a reader sees it. */
export interface Item {
  readonly id: number;
  /** Its `infe` item type, or `""` for a version of `infe` with none. */
  readonly type: string;
  /** How its `iloc` entry says where its data is: 0 the file, 1 `idat`, 2 another item. */
  readonly method: number;
  /** Where its data lies in the file, absolute, for the file's own offsets. */
  readonly extents: readonly { readonly offset: number; readonly length: number }[];
}

/**
 * The items of the `meta` of a HEIF file: their types from `iinf`, and where their data is
 * from `iloc`.
 * @param bytes - The file.
 * @returns The items, in the order of `iloc`.
 */
export const itemsOf = (bytes: Uint8Array): readonly Item[] => {
  const meta = boxAt(bytes, "meta");

  if (meta === undefined) {
    return [];
  }

  const children = childrenOf(bytes, meta);
  const iinf = children.find(({ type }) => type === "iinf");
  const iloc = children.find(({ type }) => type === "iloc");
  const types = new Map<number, string>();

  if (iinf !== undefined) {
    for (const infe of childrenOf(bytes, iinf)) {
      const version = bytes[infe.start + infe.header] ?? 0;
      const at = infe.start + infe.header + 4;

      if (version >= 2) {
        const idWidth = version === 2 ? 2 : 4;

        types.set(be(bytes, at, idWidth), fourCC(bytes, at + idWidth + 2));
      } else {
        types.set(be(bytes, at, 2), "");
      }
    }
  }

  if (iloc === undefined) {
    return [];
  }

  const body = iloc.start + iloc.header;
  const version = bytes[body] ?? 0;
  const offsetSize = Math.floor((bytes[body + 4] ?? 0) / 16);
  const lengthSize = (bytes[body + 4] ?? 0) % 16;
  const baseSize = Math.floor((bytes[body + 5] ?? 0) / 16);
  const indexSize = version === 0 ? 0 : (bytes[body + 5] ?? 0) % 16;
  const idWidth = version < 2 ? 2 : 4;
  let at = body + 6;
  const count = be(bytes, at, idWidth);

  at += idWidth;

  const items: Item[] = [];

  for (let n = 0; n < count; n += 1) {
    const id = be(bytes, at, idWidth);

    at += idWidth;

    let method = 0;

    if (version > 0) {
      method = be(bytes, at, 2) % 16;
      at += 2;
    }

    at += 2;

    const base = be(bytes, at, baseSize);

    at += baseSize;

    const extentCount = be(bytes, at, 2);

    at += 2;

    const extents: { offset: number; length: number }[] = [];

    for (let e = 0; e < extentCount; e += 1) {
      at += indexSize;
      extents.push({
        length: be(bytes, at + offsetSize, lengthSize),
        offset: base + be(bytes, at, offsetSize),
      });
      at += offsetSize + lengthSize;
    }

    items.push({ extents, id, method, type: types.get(id) ?? "" });
  }

  return items;
};

/**
 * The bytes of an item's extents in a file, joined.
 * @param bytes - The file.
 * @param item - The item.
 * @returns The bytes.
 */
export const itemData = (bytes: Uint8Array, item: Item): Uint8Array =>
  cat(...item.extents.map(({ length, offset }) => bytes.subarray(offset, offset + length)));

/**
 * The properties in a HEIF file's `ipco`, by type.
 * @param bytes - The file.
 * @returns The types, in order.
 */
export const propertyTypes = (bytes: Uint8Array): readonly string[] => {
  const ipco = boxAt(bytes, "meta", "iprp", "ipco");

  return ipco === undefined ? [] : childrenOf(bytes, ipco).map(({ type }) => type);
};

/**
 * The payload of a file's top-level `mdat`.
 * @param bytes - The file.
 * @returns Its bytes.
 */
export const mdatOf = (bytes: Uint8Array): Uint8Array => {
  const mdat = boxesIn(bytes).find(({ type }) => type === "mdat");

  return mdat === undefined ? new Uint8Array() : payloadOf(bytes, mdat);
};

/** An item of a HEIF file to be built. */
export interface HeifItem {
  readonly id: number;
  /** Its `infe` item type. */
  readonly type: string;
  readonly data: Uint8Array;
  /** Where its data is put: after the others in the `mdat`, or in `idat`, which makes its construction method 1. */
  readonly in?: "idat" | "mdat";
  /** Extents to say instead of where the data was put, offsets from the `mdat` payload or the `idat`, which is how an entry that lies is made. */
  readonly at?: readonly { readonly offset: number; readonly length: number }[];
  /** A data reference index to say instead of 0. */
  readonly dataReference?: number;
}

/** What a HEIF file is built with. */
export interface HeifOptions {
  readonly items: readonly HeifItem[];
  /** The item `pitm` names, or none for no `pitm`. */
  readonly primary?: number;
  /** The boxes of `ipco`, in order. */
  readonly properties?: readonly Uint8Array[];
  /** Which properties, by their 1-based index, each item has. */
  readonly associations?: readonly { readonly id: number; readonly indices: readonly number[] }[];
  readonly references?: readonly {
    readonly type: string;
    readonly from: number;
    readonly to: readonly number[];
  }[];
  /** The handler of `meta`, `pict` unless said. */
  readonly handler?: string;
  /** Boxes to put in `meta` after the rest, such as a `grpl`. */
  readonly extra?: readonly Uint8Array[];
  /** The versions and widths of the boxes, to build each as a file of another encoder would. */
  readonly layout?: {
    readonly infe?: 2 | 3;
    readonly iinf?: 0 | 1;
    readonly iloc?: 0 | 1 | 2;
    readonly offsetSize?: number;
    readonly lengthSize?: number;
    /** When above 0, an extent's offset is from the `mdat` payload and the entry's base offset is where that is. */
    readonly baseSize?: number;
    readonly ipma?: 0 | 1;
    readonly ipmaWide?: boolean;
    readonly iref?: 0 | 1;
    readonly pitm?: 0 | 1;
  };
  readonly brand?: string;
}

/** A HEIF file built, and where the data of its parts is. */
export interface Heif {
  readonly bytes: Uint8Array;
  /** The `mdat`'s payload. */
  readonly mdat: { readonly start: number; readonly end: number };
  /** The `meta` box. */
  readonly meta: { readonly start: number; readonly end: number };
  /** Where each item's extents are, absolute, as built. */
  readonly extents: ReadonlyMap<
    number,
    readonly { readonly offset: number; readonly length: number }[]
  >;
}

const zeros = (count: number) => new Uint8Array(count);

type Layout = NonNullable<HeifOptions["layout"]>;

type Extents = readonly { readonly offset: number; readonly length: number }[];

// Where each item's data is put: after the one before, in `mdat` and in `idat`.
const placeData = (items: readonly HeifItem[]) => {
  const placed = new Map<number, Extents>();
  const mdat: Uint8Array[] = [];
  const idat: Uint8Array[] = [];
  let mdatSize = 0;
  let idatSize = 0;

  for (const item of items) {
    if (item.in === "idat") {
      placed.set(item.id, [{ length: item.data.length, offset: idatSize }]);
      idatSize += item.data.length;
      idat.push(item.data);
    } else {
      placed.set(item.id, [{ length: item.data.length, offset: mdatSize }]);
      mdatSize += item.data.length;
      mdat.push(item.data);
    }
  }

  return { idat, idatSize, mdat, mdatSize, placed };
};

const iinfBox = (items: readonly HeifItem[], layout: Layout) => {
  const version = layout.infe ?? 2;

  return fullBox(
    "iinf",
    layout.iinf ?? 0,
    0,
    u(items.length, layout.iinf === 1 ? 4 : 2),
    ...items.map((item) =>
      fullBox(
        "infe",
        version,
        0,
        u(item.id, version === 3 ? 4 : 2),
        u(0, 2),
        text(item.type),
        text("\0")
      )
    )
  );
};

const irefBox = (options: HeifOptions) => {
  const version = options.layout?.iref ?? 0;
  const width = version === 1 ? 4 : 2;

  return fullBox(
    "iref",
    version,
    0,
    ...(options.references ?? []).map(({ from, to, type }) =>
      box(type, u(from, width), u(to.length, 2), ...to.map((id) => u(id, width)))
    )
  );
};

const iprpBox = (options: HeifOptions) => {
  const version = options.layout?.ipma ?? 0;
  const wide = options.layout?.ipmaWide === true;
  const associations = options.associations ?? [];

  const ipma = fullBox(
    "ipma",
    version,
    wide ? 1 : 0,
    u(associations.length, 4),
    ...associations.map(({ id, indices }) =>
      cat(
        u(id, version === 0 ? 2 : 4),
        u(indices.length, 1),
        ...indices.map((i) => u(i, wide ? 2 : 1))
      )
    )
  );

  return box("iprp", box("ipco", ...(options.properties ?? [])), ipma);
};

// `iloc` with every extent's offset absolute, or from `mdatStart` when it has a base offset.
const ilocBox = (
  items: readonly HeifItem[],
  placed: ReadonlyMap<number, Extents>,
  layout: Layout,
  mdatStart: number
) => {
  const version = layout.iloc ?? 1;
  const offsetSize = layout.offsetSize ?? 4;
  const lengthSize = layout.lengthSize ?? 4;
  const baseSize = layout.baseSize ?? 0;
  const idSize = version === 2 ? 4 : 2;

  const entries = items.map((item) => {
    const method = item.in === "idat" ? 1 : 0;
    const absolute = method === 0 && baseSize === 0;

    return cat(
      u(item.id, idSize),
      ...(version === 0 ? [] : [u(method, 2)]),
      u(item.dataReference ?? 0, 2),
      u(baseSize > 0 && method === 0 ? mdatStart : 0, baseSize),
      u((item.at ?? placed.get(item.id) ?? []).length, 2),
      ...(item.at ?? placed.get(item.id) ?? []).map(({ length, offset }) =>
        cat(u(absolute ? mdatStart + offset : offset, offsetSize), u(length, lengthSize))
      )
    );
  });

  return fullBox(
    "iloc",
    version,
    0,
    u(offsetSize * 16 + lengthSize, 1),
    u(baseSize * 16, 1),
    u(items.length, idSize),
    ...entries
  );
};

/**
 * A HEIF file of exactly the parts a test is about: `ftyp`, `meta` with the items and what
 * names them, and an `mdat` with the items' data. `iloc` offsets are absolute and right unless
 * an item says otherwise.
 * @param options - What it is built with.
 * @returns The file.
 */
export const heif = (options: HeifOptions): Heif => {
  const layout = options.layout ?? {};
  const ftyp = box("ftyp", text(options.brand ?? "heic"), u(0, 4), text("mif1"), text("heic"));
  const data = placeData(options.items);
  const idat = data.idatSize > 0 ? box("idat", ...data.idat) : new Uint8Array();

  const meta = (mdatStart: number) =>
    box(
      "meta",
      u(0, 4),
      fullBox("hdlr", 0, 0, u(0, 4), text(options.handler ?? "pict"), zeros(12), text("\0")),
      ...(options.primary === undefined
        ? []
        : [fullBox("pitm", layout.pitm ?? 0, 0, u(options.primary, layout.pitm === 1 ? 4 : 2))]),
      ilocBox(options.items, data.placed, layout, mdatStart),
      iinfBox(options.items, layout),
      ...((options.references ?? []).length === 0 ? [] : [irefBox(options)]),
      iprpBox(options),
      idat,
      ...(options.extra ?? [])
    );

  // The size of `meta` does not depend on the offsets in it, which are of a fixed width.
  const mdatStart = ftyp.length + meta(0).length + 8;
  const metaBox = meta(mdatStart);
  const extents = new Map<number, Extents>();

  for (const item of options.items) {
    const base = item.in === "idat" ? 0 : mdatStart;

    extents.set(
      item.id,
      (item.at ?? data.placed.get(item.id) ?? []).map(({ length, offset }) => ({
        length,
        offset: base + offset,
      }))
    );
  }

  return {
    bytes: cat(ftyp, metaBox, box("mdat", ...data.mdat)),
    extents,
    mdat: { end: mdatStart + data.mdatSize, start: mdatStart },
    meta: { end: ftyp.length + metaBox.length, start: ftyp.length },
  };
};

/** A track of a movie to be built. */
export interface MovieTrack {
  readonly id: number;
  /** The handler type its `mdia`'s `hdlr` names, or none for no `hdlr`. */
  readonly handler?: string;
  /** The type of its one sample entry. */
  readonly entry?: string;
  /** Its samples, chunk by chunk. */
  readonly chunks: readonly (readonly Uint8Array[])[];
  /** Its `tref`, as each reference type and the track ids it names. */
  readonly references?: readonly { readonly type: string; readonly ids: readonly number[] }[];
  /** Whether chunk offsets are 32-bit `stco` or 64-bit `co64`. */
  readonly offsets?: "stco" | "co64";
  /** Chunk offsets to say instead of where the chunks were put, which is how a table that lies is made. */
  readonly at?: readonly number[];
  /** Whether it has a sample table, as it does unless said. */
  readonly table?: boolean;
}

/** What a movie is built with. */
export interface MovieOptions {
  readonly tracks: readonly MovieTrack[];
  /** Whether `moov` has an `mvex` with a `trex` for each track. */
  readonly fragmented?: boolean;
  readonly brand?: string;
}

/** A movie built, and where each track's chunks are. */
export interface Movie {
  readonly bytes: Uint8Array;
  readonly chunks: ReadonlyMap<number, readonly { readonly start: number; readonly end: number }[]>;
}

const sampleTableOf = (track: MovieTrack, offsets: readonly number[]) => {
  const samples = track.chunks.flat();
  const size = samples[0]?.length ?? 0;
  const same = samples.every((sample) => sample.length === size);
  const runs: [number, number][] = [];

  for (const [index, chunk] of track.chunks.entries()) {
    if (runs.at(-1)?.[1] !== chunk.length) {
      runs.push([index + 1, chunk.length]);
    }
  }

  const wide = track.offsets === "co64";

  return box(
    "stbl",
    fullBox("stsd", 0, 0, u(1, 4), box(track.entry ?? "zzzz", zeros(8))),
    fullBox("stts", 0, 0, u(1, 4), u(samples.length, 4), u(1, 4)),
    fullBox(
      "stsc",
      0,
      0,
      u(runs.length, 4),
      ...runs.map(([first, count]) => cat(u(first, 4), u(count, 4), u(1, 4)))
    ),
    fullBox(
      "stsz",
      0,
      0,
      u(same ? size : 0, 4),
      u(samples.length, 4),
      ...(same ? [] : samples.map((sample) => u(sample.length, 4)))
    ),
    fullBox(
      wide ? "co64" : "stco",
      0,
      0,
      u(offsets.length, 4),
      ...offsets.map((at) => u(at, wide ? 8 : 4))
    )
  );
};

const trakOf = (track: MovieTrack, offsets: readonly number[]) =>
  box(
    "trak",
    fullBox("tkhd", 0, 0, u(0, 8), u(track.id, 4), zeros(68)),
    ...(track.references === undefined
      ? []
      : [
          box(
            "tref",
            ...track.references.map(({ ids, type }) => box(type, ...ids.map((id) => u(id, 4))))
          ),
        ]),
    box(
      "mdia",
      fullBox("mdhd", 0, 0, zeros(20)),
      ...(track.handler === undefined
        ? []
        : [fullBox("hdlr", 0, 0, u(0, 4), text(track.handler), zeros(12), text("\0"))]),
      box(
        "minf",
        fullBox("nmhd", 0, 0),
        box("dinf", fullBox("dref", 0, 0, u(1, 4), fullBox("url ", 0, 1))),
        ...(track.table === false ? [] : [sampleTableOf(track, track.at ?? offsets)])
      )
    )
  );

/**
 * A movie of exactly the tracks a test is about: `ftyp`, `moov` with a `trak` for each, and
 * an `mdat` with their chunks interleaved, the first chunk of each track, then the second.
 * @param options - What it is built with.
 * @returns The file, and where each track's chunks are.
 */
export const movie = (options: MovieOptions): Movie => {
  const ftyp = box("ftyp", text(options.brand ?? "isom"), u(0, 4), text("isom"));
  const most = Math.max(0, ...options.tracks.map(({ chunks }) => chunks.length));

  const order = Array.from({ length: most }, (_, index) =>
    options.tracks.flatMap((track) => {
      const chunk = track.chunks[index];

      return chunk === undefined ? [] : [{ chunk: cat(...chunk), id: track.id }];
    })
  ).flat();

  const moov = (start: number) => {
    const offsets = new Map<number, number[]>();
    let at = start;

    for (const { chunk, id } of order) {
      offsets.set(id, [...(offsets.get(id) ?? []), at]);
      at += chunk.length;
    }

    return box(
      "moov",
      fullBox("mvhd", 0, 0, zeros(96)),
      ...options.tracks.map((track) => trakOf(track, offsets.get(track.id) ?? [])),
      ...(options.fragmented === true
        ? [
            box(
              "mvex",
              ...options.tracks.map(({ id }) => fullBox("trex", 0, 0, u(id, 4), zeros(16)))
            ),
          ]
        : [])
    );
  };

  const start = ftyp.length + moov(0).length + 8;
  const bytes = cat(ftyp, moov(start), box("mdat", ...order.map(({ chunk }) => chunk)));
  const chunks = new Map<number, { start: number; end: number }[]>();
  let at = start;

  for (const { chunk, id } of order) {
    chunks.set(id, [...(chunks.get(id) ?? []), { end: at + chunk.length, start: at }]);
    at += chunk.length;
  }

  return { bytes, chunks };
};
