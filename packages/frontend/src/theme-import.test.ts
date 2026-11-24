import { describe, expect, it } from "vitest";

import draculaBase24 from "../../../fixtures/themes/dracula-base24.yaml?raw";
import draculaKitty from "../../../fixtures/themes/dracula.conf?raw";
import draculaTerminal from "../../../fixtures/themes/dracula.json?raw";
import nordGhostty from "../../../fixtures/themes/ghostty-nord?raw";
import gruvbox from "../../../fixtures/themes/gruvbox-dark-medium.yaml?raw";
import nordIterm from "../../../fixtures/themes/Nord.itermcolors?raw";
import nordAlacritty from "../../../fixtures/themes/nord.toml?raw";
import { importTheme, nameFrom } from "./theme-import.ts";

const nordAnsi = [
  "#3b4252",
  "#bf616a",
  "#a3be8c",
  "#ebcb8b",
  "#81a1c1",
  "#b48ead",
  "#88c0d0",
  "#e5e9f0",
  "#4c566a",
  "#bf616a",
  "#a3be8c",
  "#ebcb8b",
  "#81a1c1",
  "#b48ead",
  "#8fbcbb",
  "#eceff4",
];

const draculaAnsi = [
  "#21222c",
  "#ff5555",
  "#50fa7b",
  "#f1fa8c",
  "#bd93f9",
  "#ff79c6",
  "#8be9fd",
  "#f8f8f2",
  "#6272a4",
  "#ff6e6e",
  "#69ff94",
  "#ffffa5",
  "#d6acff",
  "#ff92df",
  "#a4ffff",
  "#ffffff",
];

const nord = { background: "#2e3440", foreground: "#d8dee9" };
const dracula = { background: "#282a36", foreground: "#f8f8f2" };

/**
 * Why a text is refused, or that it was not.
 * @param text - The text.
 * @returns The reason, or `"read"`.
 */
const refusal = (text: string) => {
  const read = importTheme(text);

  return read._tag === "Invalid" ? read.message : "read";
};

/**
 * What a text reads as, in brief: its format, name, background, and foreground, or why not.
 * @param text - The text.
 * @returns What it reads as.
 */
const brief = (text: string) => {
  const one = importTheme(text);

  return one._tag === "Parsed"
    ? [one.value.format, one.value.name, one.value.palette.background, one.value.palette.foreground]
    : one.message;
};

describe("importing a theme", () => {
  it("reads a real file of each format, telling the format from the text", () => {
    expect({
      alacritty: importTheme(nordAlacritty),
      base16: importTheme(gruvbox),
      base24: importTheme(draculaBase24),
      ghostty: importTheme(nordGhostty),
      iterm: importTheme(nordIterm),
      kitty: importTheme(draculaKitty),
      terminal: importTheme(draculaTerminal),
    }).toStrictEqual({
      alacritty: {
        _tag: "Parsed",
        value: {
          format: "Alacritty",
          name: undefined,
          palette: { ...nord, ansi: nordAnsi, cursor: "#d8dee9", selection: "#4c566a" },
        },
      },
      base16: {
        _tag: "Parsed",
        value: {
          format: "base16",
          name: "gruvbox-dark-medium",
          palette: {
            ansi: [
              "#282828",
              "#fb4934",
              "#b8bb26",
              "#fabd2f",
              "#83a598",
              "#d3869b",
              "#8ec07c",
              "#d5c4a1",
              "#665c54",
              "#fb4934",
              "#b8bb26",
              "#fabd2f",
              "#83a598",
              "#d3869b",
              "#8ec07c",
              "#fbf1c7",
            ],
            background: "#282828",
            cursor: "#d5c4a1",
            foreground: "#d5c4a1",
            selection: "#504945",
          },
        },
      },
      base24: {
        _tag: "Parsed",
        value: {
          format: "base24",
          name: "dracula",
          palette: {
            ...dracula,
            ansi: ["#282a36", ...draculaAnsi.slice(1)],
            cursor: "#f8f8f2",
            selection: "#44475a",
          },
        },
      },
      ghostty: {
        _tag: "Parsed",
        value: {
          format: "Ghostty",
          name: undefined,
          palette: {
            ...nord,
            ansi: nordAnsi.map((colour, index) => (index === 8 ? "#596377" : colour)),
            cursor: "#eceff4",
            selection: "#eceff4",
          },
        },
      },
      iterm: {
        _tag: "Parsed",
        value: {
          format: "iTerm2",
          name: undefined,
          palette: { ...nord, ansi: nordAnsi, cursor: "#eceff4", selection: "#eceff4" },
        },
      },
      kitty: {
        _tag: "Parsed",
        value: {
          format: "Kitty",
          name: undefined,
          palette: { ...dracula, ansi: draculaAnsi, cursor: "#f8f8f2", selection: "#44475a" },
        },
      },
      terminal: {
        _tag: "Parsed",
        value: {
          format: "Windows Terminal",
          name: "dracula",
          palette: { ...dracula, ansi: draculaAnsi, cursor: "#f8f8f2", selection: "#44475a" },
        },
      },
    });
  });

  it("reads the older base16 layout, Alacritty's YAML, 0x and short hex, and a P3 colour", () => {
    const base16 = [
      'scheme: "Old One"',
      ...Array.from(
        { length: 16 },
        (_, index) =>
          `base0${index.toString(16).toUpperCase()}: "${index < 8 ? "111111" : "aa0000"}"`
      ),
    ].join("\n");

    const alacritty = [
      "colors:",
      "  primary:",
      "    background: '0x101010'",
      "    foreground: '#eee'",
      ...["normal", "bright"].flatMap((group) => [
        `  ${group}:`,
        ...["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"].map(
          (name) => `    ${name}: '#808080'`
        ),
      ]),
    ].join("\n");

    const p3 = nordIterm.replace(
      /(?<before><key>Background Color<\/key>\s*<dict>[\s\S]*?<string>)sRGB/u,
      "$<before>P3"
    );

    expect({ alacritty: brief(alacritty), base16: brief(base16), p3: brief(p3) }).toStrictEqual({
      alacritty: ["Alacritty", undefined, "#101010", "#eeeeee"],
      base16: ["base16", "old-one", "#111111", "#111111"],
      p3: ["iTerm2", undefined, "#2d3441", "#d8dee9"],
    });
  });

  it("says in words why it cannot read malformed text", () => {
    expect({
      alacrittyBad: refusal(nordAlacritty.replace("red = '#BF616A'", "red = 'red'")),
      alacrittyMissing: refusal(nordAlacritty.replace("cyan = '#8FBCBB'\n", "")),
      alacrittyNumber: refusal(nordAlacritty.replace("red = '#BF616A'", "red = 12")),
      badHex: refusal(draculaKitty.replace("color3  #f1fa8c", "color3  #f1fa8")),
      empty: refusal(""),
      ghosttyMissing: refusal(nordGhostty.replace("palette = 5=#b48ead\n", "")),
      iterm: refusal(nordIterm.replace("<key>Ansi 4 Color</key>", "<key>Ansi 4 Colour</key>")),
      json: refusal("{ not json"),
      named: refusal(draculaKitty.replace("color6  #8be9fd", "color6  cyan")),
      prose: refusal("Some text that is no theme at all."),
      schemes: refusal('{ "schemes": [{}, {}] }'),
      terminalMissing: refusal(draculaTerminal.replace('"brightPurple": "#ff92df",', "")),
      toml: refusal("[colors.primary]\nbackground = "),
      unclosed: refusal("<plist><dict><key>Ansi 0 Color</key>"),
      unquoted: refusal(gruvbox.replace('base0A: "#fabd2f"', "base0A: 0")),
      yaml: refusal('base00: "#282828"\n  - [unbalanced'),
    }).toStrictEqual({
      alacrittyBad: "colors.normal.red is not a color in #rrggbb form.",
      alacrittyMissing: "colors.bright.cyan is missing.",
      alacrittyNumber: "colors.normal.red is not a color in #rrggbb form.",
      badHex: "color3 is not a color in #rrggbb form.",
      empty:
        "This is not a theme iirc can read: base16 or base24 YAML, iTerm2's .itermcolors, Alacritty's TOML, Kitty's or Ghostty's config file, or a Windows Terminal scheme.",
      ghosttyMissing: "palette 5 is missing.",
      iterm: "Ansi 4 Color is missing.",
      json: "This JSON cannot be read: it is not JSON.",
      named: "color6 is not a color in #rrggbb form.",
      prose:
        "This is not a theme iirc can read: base16 or base24 YAML, iTerm2's .itermcolors, Alacritty's TOML, Kitty's or Ghostty's config file, or a Windows Terminal scheme.",
      schemes: "This is a settings file with 2 schemes. Paste one scheme, the object in braces.",
      terminalMissing: "brightPurple is missing.",
      toml: "This TOML cannot be read: Expected a value at line 2, column 14.",
      unclosed: "This plist ends before its last value is complete.",
      unquoted: "palette.base0A is not a color in #rrggbb form.",
      yaml: "This YAML cannot be read: Unexpected indentation of 2 spaces at line 2.",
    });
  });

  it("reads past blank or whitespace lines, and a line of no setting, before the theme", () => {
    const blank = "\n".repeat(3);
    const spaces = " \t \n".repeat(3);

    expect({
      alacritty: refusal(`${blank}${nordAlacritty}`),
      base16: refusal(`${spaces}${gruvbox}`),
      ghostty: refusal(`${blank}${nordGhostty}`),
      iterm: refusal(`${spaces}${nordIterm}`),
      kitty: refusal(`${blank}${draculaKitty}`),
      line: refusal(`xxxx\n${draculaKitty}`),
      terminal: refusal(`${spaces}${draculaTerminal}`),
    }).toStrictEqual({
      alacritty: "read",
      base16: "read",
      ghostty: "read",
      iterm: "read",
      kitty: "read",
      line: "read",
      terminal: "read",
    });
  });

  it("takes declarations only before the root, and only comments after </plist>", () => {
    const body = nordIterm.slice(nordIterm.indexOf("<plist"));

    expect({
      before: refusal(`<?xml version="1.0"?>\n<!DOCTYPE plist>\n${body}`),
      declarationAfter: refusal(`${nordIterm}<?xml version="1.0"?>\n`),
      doctypeAfter: refusal(`${nordIterm}<!DOCTYPE plist>\n`),
      inside: refusal(nordIterm.replace("<dict>", '<dict><?xml version="1.0"?>')),
      instructionAfter: refusal(`${nordIterm}<?php echo 1 ?>\n`),
    }).toStrictEqual({
      before: "read",
      declarationAfter: "This plist continues after </plist>, where only comments are allowed.",
      doctypeAfter: "This plist continues after </plist>, where only comments are allowed.",
      inside: "This plist has a dict whose entries are not a key, then a value.",
      instructionAfter: "This plist continues after </plist>, where only comments are allowed.",
    });
  });

  it("refuses a plist whose containers are not closed as they were opened, or that goes on after it", () => {
    expect({
      afterEnd: refusal(`${nordIterm}<plist/>`),
      comment: refusal(`${nordIterm}<!-- a comment after -->\n`),
      crossed: refusal(nordIterm.replace("</dict>\n</plist>", "</array>\n</plist>")),
      noEnd: refusal(nordIterm.replace("</plist>", "")),
      wrongEnd: refusal(nordIterm.replace("</plist>", "</dict>")),
    }).toStrictEqual({
      afterEnd: "This plist continues after </plist>, where only comments are allowed.",
      comment: "read",
      crossed: "This plist's <dict> is closed by </array>.",
      noEnd: "This plist's <plist> is not closed after its one value.",
      wrongEnd: "This plist's <plist> is not closed after its one value.",
    });
  });

  it("skips a Ghostty setting it does not know", () => {
    expect(refusal(`font-size = 14\n${nordGhostty}`)).toBe("read");
  });

  it("makes a theme's name from the name a file gives", () => {
    expect(
      [
        "Gruvbox dark, medium",
        "Tokyo Night",
        "  ",
        "Ünïcode only",
        "x".repeat(40),
        "a b ".repeat(20),
      ].map(nameFrom)
    ).toStrictEqual([
      "gruvbox-dark-medium",
      "tokyo-night",
      undefined,
      "n-code-only",
      undefined,
      "a-b-a-b-a-b-a-b-a-b-a-b-a-b-a-b",
    ]);
  });
});
