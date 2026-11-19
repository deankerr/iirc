import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { holds, jpegWithGps } from "../../testing/images.ts";
import {
  box,
  boxAt,
  cat,
  childrenOf,
  clipMov,
  clipMp4,
  fullBox,
  heif,
  itemData,
  itemsOf,
  largeBox,
  mdatOf,
  pathsOf,
  payloadOf,
  photoAvif,
  photoHeic,
  propertyTypes,
  text,
  toEndBox,
  u,
} from "../../testing/isobmff.ts";
import type { HeifItem, HeifOptions } from "../../testing/isobmff.ts";
import type { Patch } from "./boxes.ts";
import { plan } from "./isobmff.ts";
import type { Layout, Reader } from "./isobmff.ts";

/** What stripping gives, with the patches applied. */
type Result =
  | { readonly _tag: "Stripped"; readonly bytes: Uint8Array }
  | { readonly _tag: "Unreadable"; readonly reason: string };

const inMemory =
  (bytes: Uint8Array): Reader =>
  (at, length) =>
    Effect.succeed(bytes.subarray(at, at + length));

const applyPatches = (bytes: Uint8Array, patches: readonly Patch[]) => {
  const out = Uint8Array.from(bytes);

  for (const patch of patches) {
    if ("bytes" in patch) {
      out.set(patch.bytes, patch.at);
    } else {
      out.fill(0, patch.at, patch.at + patch.zeros);
    }
  }

  return out;
};

const strip = (layout: Layout, bytes: Uint8Array): Result => {
  const planned = Effect.runSync(plan(layout, inMemory(bytes), bytes.length));

  return planned._tag === "Planned"
    ? { _tag: "Stripped", bytes: applyPatches(bytes, planned.patches) }
    : planned;
};

const stripped = (layout: Layout, bytes: Uint8Array): Uint8Array => {
  const result = strip(layout, bytes);

  if (result._tag === "Unreadable") {
    throw new Error(result.reason);
  }

  return result.bytes;
};

const reasonOf = (layout: Layout, bytes: Uint8Array) => {
  const result = strip(layout, bytes);

  return result._tag === "Unreadable" ? result.reason : "stripped";
};

const zeros = (count: number) => new Uint8Array(count);

const secret = text("SECRET-LOCATION");

const ftyp = box("ftyp", text("isom"), u(0, 4), text("isom"));

const mvhd = fullBox("mvhd", 0, 0, zeros(96));

const media = box("mdat", text("MEDIA-BYTES"));

const moov = (...children: readonly Uint8Array[]) => box("moov", mvhd, ...children);

const movieContainers = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "moof",
  "traf",
  "meta",
  "mfra",
]);

describe("walking a movie", () => {
  it("retypes a box that is on no keep-list to free, zeroed where it is, at every level", () => {
    const stsd = fullBox("stsd", 0, 0, u(0, 4));

    const file = cat(
      ftyp,
      moov(
        box(
          "trak",
          fullBox("tkhd", 0, 0, zeros(80)),
          box(
            "mdia",
            fullBox("mdhd", 0, 0, zeros(20)),
            box(
              "minf",
              fullBox("vmhd", 0, 1, zeros(8)),
              box("stbl", stsd, box("zzzz", secret)),
              box("zzzz", secret)
            ),
            box("zzzz", secret)
          ),
          box("meta", secret),
          box("udta", box("©xyz", secret))
        )
      ),
      box("uuid", secret),
      media
    );

    const out = stripped("movie", file);

    expect({
      length: out.length,
      mdat: mdatOf(out),
      paths: pathsOf(out, movieContainers),
      secret: holds(out, "SECRET"),
      stsd: holds(out, "stsd"),
    }).toStrictEqual({
      length: file.length,
      mdat: mdatOf(file),
      paths: [
        "ftyp",
        "moov",
        "moov/mvhd",
        "moov/trak",
        "moov/trak/tkhd",
        "moov/trak/mdia",
        "moov/trak/mdia/mdhd",
        "moov/trak/mdia/minf",
        "moov/trak/mdia/minf/vmhd",
        "moov/trak/mdia/minf/stbl",
        "moov/trak/mdia/minf/stbl/stsd",
        "moov/trak/mdia/minf/stbl/free",
        "moov/trak/mdia/minf/free",
        "moov/trak/mdia/free",
        "moov/trak/free",
        "moov/trak/free",
        "free",
        "mdat",
      ],
      secret: false,
      stsd: true,
    });
  });

  it("keeps a free box's place and zeroes what was in it", () => {
    const file = cat(ftyp, box("free", secret), moov(), media);
    const out = stripped("movie", file);

    expect({ free: holds(out, "SECRET"), length: out.length }).toStrictEqual({
      free: false,
      length: file.length,
    });
  });

  it("keeps the shape of a 64-bit box's header and zeroes its payload", () => {
    const file = cat(ftyp, largeBox("uuid", secret), moov(), media);
    const out = stripped("movie", file);
    const at = ftyp.length;

    expect({
      header: out.subarray(at, at + 16),
      length: out.length,
      payload: out.subarray(at + 16, at + 16 + secret.length),
    }).toStrictEqual({
      header: cat(u(1, 4), text("free"), u(16 + secret.length, 8)),
      length: file.length,
      payload: zeros(secret.length),
    });
  });

  it("zeroes a box that runs to the end of the file, and keeps one that is media", () => {
    const toEnd = cat(ftyp, moov(), toEndBox("XMP_", secret));
    const out = stripped("movie", toEnd);
    const kept = cat(ftyp, moov(), toEndBox("mdat", text("MEDIA")));

    expect({
      kept: stripped("movie", kept),
      length: out.length,
      payload: out.subarray(-secret.length),
      type: out.subarray(ftyp.length + moov().length + 4, ftyp.length + moov().length + 8),
    }).toStrictEqual({
      kept,
      length: toEnd.length,
      payload: zeros(secret.length),
      type: text("free"),
    });
  });

  it("keeps a 64-bit mdat as it is", () => {
    const file = cat(ftyp, moov(), largeBox("mdat", text("MEDIA")));

    expect(stripped("movie", file)).toStrictEqual(file);
  });

  it("keeps a QuickTime atom list's zero terminator, and refuses other bytes too short to be a box", () => {
    const terminated = cat(ftyp, moov(box("udta", secret), u(0, 4)), media, u(0, 4));
    const odd = cat(ftyp, moov(), media, Uint8Array.of(0, 1, 2));
    const out = stripped("movie", terminated);

    expect({
      odd: reasonOf("movie", odd),
      secret: holds(out, "SECRET"),
      terminator: out.subarray(-4),
    }).toStrictEqual({
      odd: "a box header is cut short",
      secret: false,
      terminator: u(0, 4),
    });
  });

  it.each([
    ["a top-level box that runs past the end", cat(ftyp, media).subarray(0, -3)],
    ["a top-level header that is cut short", cat(ftyp, Uint8Array.of(0, 0, 0, 9, 1))],
    ["a top-level box smaller than its header", cat(ftyp, u(4, 4), text("free"))],
    ["a 64-bit size that is cut short", cat(ftyp, u(1, 4), text("free"), zeros(3))],
    ["a 64-bit size smaller than its header", cat(ftyp, u(1, 4), text("free"), u(8, 8))],
    ["a child that runs past its parent", cat(ftyp, box("moov", u(1000, 4), text("trak")))],
    ["a child smaller than its header", cat(ftyp, box("moov", u(3, 4), text("trak"), zeros(8)))],
    [
      "a grandchild that runs past its parent",
      cat(ftyp, moov(box("trak", box("mdia", u(40, 4), text("mdhd"))))),
    ],
    ["a moov whose last bytes are too short to be a box", cat(ftyp, moov(Uint8Array.of(1, 2)))],
  ] as const)("refuses %s", (_, file) => {
    expect(strip("movie", file)._tag).toBe("Unreadable");
  });

  it("walks a fragment, retyping what is not a fragment's, and keeps what indexes them", () => {
    const sidx = fullBox("sidx", 0, 0, zeros(20));

    const file = cat(
      ftyp,
      moov(box("pssh", secret)),
      sidx,
      box(
        "moof",
        fullBox("mfhd", 0, 0, u(1, 4)),
        box("traf", fullBox("tfhd", 0, 0, u(1, 4)), box("zzzz", secret)),
        box("udta", secret)
      ),
      media,
      box("mfra", fullBox("tfra", 0, 0, zeros(12)), box("zzzz", secret)),
      box("skip", secret)
    );

    const out = stripped("movie", file);

    expect({
      length: out.length,
      paths: pathsOf(out, movieContainers),
      secret: holds(out, "SECRET"),
    }).toStrictEqual({
      length: file.length,
      paths: [
        "ftyp",
        "moov",
        "moov/mvhd",
        "moov/free",
        "sidx",
        "moof",
        "moof/mfhd",
        "moof/traf",
        "moof/traf/tfhd",
        "moof/traf/free",
        "moof/free",
        "mdat",
        "mfra",
        "mfra/tfra",
        "mfra/free",
        "free",
      ],
      secret: false,
    });
  });

  it("reads only headers and the boxes it walks into, whatever the size of the media", () => {
    const head = cat(
      ftyp,
      moov(box("udta", secret)),
      u(1, 4),
      text("mdat"),
      u(3 * 1024 ** 3, 8),
      u(0, 0)
    );

    const size = head.length + 3 * 1024 ** 3 - 16;
    let total = 0;

    const read: Reader = (at, length) => {
      total += length;

      return Effect.succeed(
        at >= head.length ? zeros(length) : cat(head.subarray(at, at + length), zeros(0))
      );
    };

    const planned = Effect.runSync(plan("movie", read, size + 0));

    expect({ cheap: total < 4096, tag: planned._tag }).toStrictEqual({
      cheap: true,
      tag: "Planned",
    });
  });

  it("zeroes a box of gigabytes without holding it", () => {
    const head = cat(ftyp, u(1, 4), text("uuid"), u(5 * 1024 ** 3, 8));
    const size = ftyp.length + 5 * 1024 ** 3;
    const read: Reader = (at, length) => Effect.succeed(cat(head.subarray(at, at + length)));
    const planned = Effect.runSync(plan("movie", read, size));

    expect(
      planned._tag === "Planned"
        ? planned.patches.map((patch) => ("zeros" in patch ? patch.zeros : 0))
        : []
    ).toStrictEqual([0, 5 * 1024 ** 3 - 16]);
  });
});

const keptItem = (id: number, data: string): HeifItem => ({ data: text(data), id, type: "hvc1" });

const exifItem = (id: number, data = "Exif-SECRET-GPS"): HeifItem => ({
  data: text(data),
  id,
  type: "Exif",
});

const xmpItem = (id: number): HeifItem => ({ data: text("XMP-SECRET-GPS"), id, type: "mime" });

const props = [
  box("hvcC", text("HVCC-CONFIG")),
  fullBox("ispe", 0, 0, u(64, 4), u(48, 4)),
  box("colr", text("nclx"), zeros(7)),
  box("irot", u(1, 1)),
];

const photo: HeifOptions = {
  associations: [
    { id: 1, indices: [1, 2, 3, 4] },
    { id: 2, indices: [1, 2] },
    { id: 3, indices: [] },
  ],
  items: [keptItem(1, "IMAGE-ONE"), keptItem(2, "THUMB"), exifItem(3), xmpItem(4)],
  primary: 1,
  properties: props,
  references: [
    { from: 2, to: [1], type: "thmb" },
    { from: 3, to: [1], type: "cdsc" },
    { from: 4, to: [1], type: "cdsc" },
  ],
};

const topLevel = (bytes: Uint8Array) => pathsOf(bytes, new Set(["moov"]));

// The iloc of a built file, whose version 1 entries are 16 bytes: its count, and the id of its
// second entry, are what a lying file changes.
const withIloc = (bytes: Uint8Array, change: (iloc: Uint8Array) => void) => {
  const out = Uint8Array.from(bytes);
  const iloc = boxAt(out, "meta", "iloc");

  if (iloc === undefined) {
    throw new Error("no iloc");
  }

  change(out.subarray(iloc.start + iloc.header));

  return out;
};

const twoItems = () => heif({ items: [keptItem(1, "IMAGE-ONE"), exifItem(2)], primary: 1 });

describe("walking an image", () => {
  it("keeps the images, drops Exif and XMP with their data, and writes a free box for what meta gave up", () => {
    const built = heif(photo);
    const out = stripped("image", built.bytes);
    const items = itemsOf(out);
    const keptIds = [1, 2];

    expect({
      data: items.map((item) => itemData(out, item)),
      free: topLevel(out),
      ids: items.map(({ id }) => id),
      length: out.length,
      mdat: [out.subarray(built.mdat.start, built.mdat.end).length],
      properties: propertyTypes(out),
      refs: childrenOf(
        out,
        boxAt(out, "meta", "iref") ?? { end: 0, header: 0, start: 0, type: "" }
      ).map(({ type }) => type),
      secret: holds(out, "SECRET"),
      types: items.map(({ type }) => type),
    }).toStrictEqual({
      data: keptIds.map((id) => text(id === 1 ? "IMAGE-ONE" : "THUMB")),
      free: ["ftyp", "meta", "free", "mdat"],
      ids: keptIds,
      length: built.bytes.length,
      mdat: [built.mdat.end - built.mdat.start],
      properties: ["hvcC", "ispe", "colr", "irot"],
      refs: ["thmb"],
      secret: false,
      types: ["hvc1", "hvc1"],
    });
  });

  it("fixes the counts of items, locations and associations", () => {
    const out = stripped("image", heif(photo).bytes);
    const meta = boxAt(out, "meta");
    const iinf = boxAt(out, "meta", "iinf");
    const ipma = boxAt(out, "meta", "iprp", "ipma");

    expect({
      iinf: iinf === undefined ? 0 : (payloadOf(out, iinf)[5] ?? 0),
      ipma: ipma === undefined ? 0 : (payloadOf(out, ipma)[7] ?? 0),
      metaThenFree: meta !== undefined && boxAt(out, "free")?.start === meta.end,
    }).toStrictEqual({ iinf: 2, ipma: 2, metaThenFree: true });
  });

  it.each([
    ["the defaults", {}],
    ["32-bit item ids everywhere", { iinf: 1, iloc: 2, infe: 3, ipma: 1, iref: 1, pitm: 1 }],
    ["an iloc of version 0", { iloc: 0 }],
    ["a base offset in iloc", { baseSize: 4 }],
    ["64-bit offsets and lengths and a base offset", { baseSize: 8, lengthSize: 8, offsetSize: 8 }],
    ["15-bit property indices", { ipmaWide: true }],
  ] as const)("strips an image whose boxes have %s", (_, layout) => {
    const built = heif({ ...photo, layout });
    const out = stripped("image", built.bytes);

    expect({
      data: itemsOf(out).map((item) => itemData(out, item)),
      length: out.length,
      secret: holds(out, "SECRET"),
      types: itemsOf(out).map(({ type }) => type),
    }).toStrictEqual({
      data: [text("IMAGE-ONE"), text("THUMB")],
      length: built.bytes.length,
      secret: false,
      types: ["hvc1", "hvc1"],
    });
  });

  it("zeroes the data of an item kept in idat, and keeps the data of one that is an image there", () => {
    const built = heif({
      items: [
        keptItem(1, "IMAGE-ONE"),
        { data: text("IDAT-SECRET"), id: 2, in: "idat", type: "Exif" },
        { data: text("IDAT-KEPT"), id: 3, in: "idat", type: "hvc1" },
      ],
      primary: 1,
    });

    const out = stripped("image", built.bytes);
    const idat = boxAt(out, "meta", "idat");

    expect({
      idat: idat === undefined ? undefined : payloadOf(out, idat),
      length: out.length,
      types: itemsOf(out).map(({ type }) => type),
    }).toStrictEqual({
      idat: cat(zeros("IDAT-SECRET".length), text("IDAT-KEPT")),
      length: built.bytes.length,
      types: ["hvc1", "hvc1"],
    });
  });

  it("retypes a property that is on no keep-list to free in place, so indices do not move", () => {
    const built = heif({
      ...photo,
      associations: [{ id: 1, indices: [1, 2, 3] }],
      properties: [props[1] ?? text(""), box("zzzz", secret), props[2] ?? text("")],
    });

    const out = stripped("image", built.bytes);
    const before = boxAt(built.bytes, "meta", "iprp", "ipma");
    const after = boxAt(out, "meta", "iprp", "ipma");

    expect({
      ipma: after === undefined ? undefined : payloadOf(out, after),
      properties: propertyTypes(out),
      secret: holds(out, "SECRET"),
    }).toStrictEqual({
      ipma: before === undefined ? undefined : payloadOf(built.bytes, before),
      properties: ["ispe", "free", "colr"],
      secret: false,
    });
  });

  it("refuses an iloc whose count is lower than its entries, which would leave an item's data unlocated", () => {
    const lying = withIloc(twoItems().bytes, (iloc) => {
      iloc.set(u(1, 2), 6);
    });

    expect(reasonOf("image", lying)).toBe("an iloc has more than its count of entries");
  });

  it("refuses an iloc that lists an item twice", () => {
    const lying = withIloc(twoItems().bytes, (iloc) => {
      iloc.set(u(1, 2), 8 + 16);
    });

    expect(reasonOf("image", lying)).toBe("an iloc lists an item twice");
  });

  it("refuses a dropped item that iloc does not locate", () => {
    const lying = withIloc(twoItems().bytes, (iloc) => {
      iloc.set(u(9, 2), 8 + 16);
    });

    expect(reasonOf("image", lying)).toBe("an item is listed in iinf and not located in iloc");
  });

  it("drops a JPEG item, which holds metadata of its own, with its data", () => {
    const built = heif({
      items: [keptItem(1, "IMAGE-ONE"), { data: jpegWithGps, id: 2, type: "jpeg" }],
      primary: 1,
    });

    const out = stripped("image", built.bytes);

    expect({
      after: holds(out, "PLANTED-"),
      before: holds(built.bytes, "PLANTED-"),
      types: itemsOf(out).map(({ type }) => type),
    }).toStrictEqual({ after: false, before: true, types: ["hvc1"] });
  });

  it.each([
    ["one", false],
    ["two", true],
  ] as const)(
    "refuses an image with an essential association to a property it would retype, in %s bytes",
    (_, ipmaWide) => {
      const essential = ipmaWide ? 0x80_00 : 0x80;

      const built = heif({
        associations: [{ id: 1, indices: [1, essential + 2, 3] }],
        items: [keptItem(1, "IMAGE-ONE")],
        layout: { ipmaWide },
        primary: 1,
        properties: [props[1] ?? text(""), box("zzzz", secret), props[2] ?? text("")],
      });

      expect(reasonOf("image", built.bytes)).toBe("a kept item needs a property that is dropped");
    }
  );

  it("retypes a property that only a dropped item needs, essential or not", () => {
    const built = heif({
      associations: [
        { id: 1, indices: [1, 3] },
        { id: 2, indices: [0x80 + 2] },
      ],
      items: [keptItem(1, "IMAGE-ONE"), exifItem(2)],
      primary: 1,
      properties: [props[1] ?? text(""), box("zzzz", secret), props[2] ?? text("")],
    });

    expect(propertyTypes(stripped("image", built.bytes))).toStrictEqual(["ispe", "free", "colr"]);
  });

  it("drops a box in meta that is on no keep-list", () => {
    const built = heif({ ...photo, extra: [box("grpl", secret)] });
    const out = stripped("image", built.bytes);

    expect({ free: topLevel(out), secret: holds(out, "SECRET") }).toStrictEqual({
      free: ["ftyp", "meta", "free", "mdat"],
      secret: false,
    });
  });

  it("zeroes a box at the top level that is on no keep-list", () => {
    const built = heif(photo);
    const out = stripped("image", cat(built.bytes, box("uuid", secret)));

    expect({ secret: holds(out, "SECRET"), top: topLevel(out) }).toStrictEqual({
      secret: false,
      top: ["ftyp", "meta", "free", "mdat", "free"],
    });
  });

  it("walks the movie of an image sequence as a movie", () => {
    const built = heif({ ...photo, brand: "msf1" });
    const out = stripped("image", cat(built.bytes, moov(box("udta", secret))));

    expect({ secret: holds(out, "SECRET"), top: pathsOf(out, new Set(["moov"])) }).toStrictEqual({
      secret: false,
      top: ["ftyp", "meta", "free", "mdat", "moov", "moov/mvhd", "moov/free"],
    });
  });

  it.each([
    [
      "a dropped item's data that overlaps a kept item's",
      () => ({ at: [{ length: 8, offset: 3 }] }),
      "a dropped item's data overlaps a kept item's",
    ],
    [
      "a dropped item's data of no length",
      () => ({ at: [{ length: 0, offset: 20 }] }),
      "a dropped item has an extent of no length",
    ],
    [
      "a dropped item's data past the end of the file",
      () => ({ at: [{ length: 8, offset: 100_000 }] }),
      "a dropped item's data runs past the end of the file",
    ],
    [
      "a dropped item's data in meta",
      () => ({ at: [{ length: 8, offset: -100 }] }),
      "a dropped item's data is in meta",
    ],
    [
      "a dropped item's data in ftyp",
      // Offsets are from the start of the mdat, so the start of the file is before it.
      (mdatStart: number) => ({ at: [{ length: 4, offset: -mdatStart }] }),
      "a dropped item's data is not in an mdat",
    ],
    [
      "a dropped item's data in another file",
      () => ({ dataReference: 1 }),
      "a dropped item's data is in another file",
    ],
  ] as const)("refuses %s", (_, overrides, reason) => {
    const items = [keptItem(1, "IMAGE-ONE"), keptItem(2, "THUMB")];
    const { mdat } = heif({ items: [...items, exifItem(3)], primary: 1 });

    const built = heif({
      items: [...items, { ...exifItem(3), ...overrides(mdat.start) }],
      primary: 1,
    });

    expect(reasonOf("image", built.bytes)).toBe(reason);
  });

  it("refuses a kept item that refers to a dropped item", () => {
    const built = heif({ ...photo, references: [{ from: 1, to: [3], type: "dimg" }] });

    expect(reasonOf("image", built.bytes)).toBe("a kept item refers to a dropped item");
  });

  it.each([
    ["names a dropped item", 3],
    ["names an item that is not there", 99],
  ] as const)("refuses an image whose primary item %s", (_, primary) => {
    expect(strip("image", heif({ ...photo, primary }).bytes)._tag).toBe("Unreadable");
  });

  it("refuses a meta that does not hold a picture", () => {
    expect(reasonOf("image", heif({ ...photo, handler: "mdir" }).bytes)).toBe(
      "a meta that does not hold a picture"
    );
  });

  it("refuses an image of two metas", () => {
    const built = heif(photo);

    expect(
      strip("image", cat(built.bytes, built.bytes.subarray(built.meta.start, built.meta.end)))._tag
    ).toBe("Unreadable");
  });

  it("refuses an image whose meta would give up too little to hold a free box", () => {
    const built = heif({
      ...photo,
      associations: [
        { id: 1, indices: [1] },
        { id: 9, indices: [2] },
      ],
      items: [keptItem(1, "IMAGE-ONE")],
      references: [],
    });

    expect(reasonOf("image", built.bytes)).toBe(
      "a meta that shrinks too little to hold a free box"
    );
  });

  it("leaves an image with only images as it is", () => {
    const built = heif({
      ...photo,
      associations: [{ id: 1, indices: [1, 2] }],
      items: [keptItem(1, "IMAGE-ONE"), keptItem(2, "THUMB")],
      references: [{ from: 2, to: [1], type: "thmb" }],
    });

    expect(stripped("image", built.bytes)).toStrictEqual(built.bytes);
  });
});

const fixtures = [
  ["image", "photo.heic", photoHeic],
  ["image", "photo.avif", photoAvif],
  ["movie", "clip.mp4", clipMp4],
  ["movie", "clip.mov", clipMov],
] as const;

describe("walking a file in general", () => {
  it("strips what it stripped to the same bytes", () => {
    const again = fixtures.map(([layout, , bytes]) => {
      const once = stripped(layout, bytes);

      return { again: stripped(layout, once), once };
    });

    expect(
      again.map(({ again: second, once }) => second.every((byte, i) => byte === once[i]))
    ).toStrictEqual([true, true, true, true]);
  });

  it("never throws, nor keeps planted text, on any prefix of a file", () => {
    const survivors = fixtures.flatMap(([layout, name, bytes]) =>
      Array.from({ length: bytes.length + 1 }, (_, length) => {
        const result = strip(layout, bytes.subarray(0, length));

        return result._tag === "Stripped" && holds(result.bytes, "PLANTED-")
          ? [`${name} ${length}`]
          : [];
      }).flat()
    );

    expect(survivors).toStrictEqual([]);
  });
});
