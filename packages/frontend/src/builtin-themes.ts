/**
 * The themes iirc comes with, as palettes: its own dark and light, and well-known open
 * palettes, each under a permissive licence, named with its source beside it. Each is the
 * palette its authors give for a terminal, so it draws here as it does there.
 *
 * @packageDocumentation
 */
import type { Theme } from "@iirc/api/ui";

/**
 * iirc's own dark theme, the one `system` draws on a dark device: a near-black ground,
 * soft text, teal as its accent, and orange for what calls for the Owner. MIT, as iirc is.
 */
const dark: Theme = {
  name: "dark",
  palette: {
    ansi: [
      "#2c3134",
      "#f28b82",
      "#8bc48a",
      "#f0a35e",
      "#7cc4f5",
      "#d59ae6",
      "#5fb3b3",
      "#d4d7d6",
      "#7d8588",
      "#f7a1b5",
      "#b5d86a",
      "#e6c56b",
      "#8fb4f8",
      "#f095c4",
      "#6dd0dc",
      "#eef0ef",
    ],
    background: "#111314",
    cursor: "#5fb3b3",
    foreground: "#d4d7d6",
  },
};

/** iirc's own light theme, the one `system` draws on a light device. MIT, as iirc is. */
const light: Theme = {
  name: "light",
  palette: {
    ansi: [
      "#24292e",
      "#b3261e",
      "#2e7d32",
      "#b5560b",
      "#0277bd",
      "#8e24aa",
      "#0b6e6e",
      "#d1d0ca",
      "#6a737d",
      "#c2185b",
      "#4f7a00",
      "#8a6d00",
      "#1565c0",
      "#ad1457",
      "#00838f",
      "#ecebe6",
    ],
    background: "#f6f5f1",
    cursor: "#0b6e6e",
    foreground: "#24292e",
  },
};

/**
 * Solarized's sixteen, by Ethan Schoonover, as its terminal palettes lay them out: the
 * accents normal, and the bright slots its greys and orange and violet.
 * MIT. https://github.com/altercation/solarized
 */
const solarized = [
  "#073642",
  "#dc322f",
  "#859900",
  "#b58900",
  "#268bd2",
  "#d33682",
  "#2aa198",
  "#eee8d5",
  "#002b36",
  "#cb4b16",
  "#586e75",
  "#657b83",
  "#839496",
  "#6c71c4",
  "#93a1a1",
  "#fdf6e3",
];

/** Solarized dark. MIT. https://github.com/altercation/solarized */
const solarizedDark: Theme = {
  name: "solarized-dark",
  palette: {
    ansi: solarized,
    background: "#002b36",
    cursor: "#839496",
    foreground: "#839496",
    selection: "#073642",
  },
};

/** Solarized light. MIT. https://github.com/altercation/solarized */
const solarizedLight: Theme = {
  name: "solarized-light",
  palette: {
    ansi: solarized,
    background: "#fdf6e3",
    cursor: "#657b83",
    foreground: "#657b83",
    selection: "#eee8d5",
  },
};

/**
 * Gruvbox dark, by Pavel Pertsev. MIT/X11, as its README's licence says:
 * https://github.com/morhetz/gruvbox#license
 */
const gruvboxDark: Theme = {
  name: "gruvbox-dark",
  palette: {
    ansi: [
      "#282828",
      "#cc241d",
      "#98971a",
      "#d79921",
      "#458588",
      "#b16286",
      "#689d6a",
      "#a89984",
      "#928374",
      "#fb4934",
      "#b8bb26",
      "#fabd2f",
      "#83a598",
      "#d3869b",
      "#8ec07c",
      "#ebdbb2",
    ],
    background: "#282828",
    cursor: "#ebdbb2",
    foreground: "#ebdbb2",
    selection: "#504945",
  },
};

/**
 * Nord, by Arctic Ice Studio, as Alacritty's theme of it has it.
 * MIT, as its README's licence says: https://gh.ali360.cloudns.ch/nordtheme/nord/blob/develop/license, and Apache-2.0,
 * https://github.com/alacritty/alacritty-theme/blob/master/themes/nord.toml
 */
const nord: Theme = {
  name: "nord",
  palette: {
    ansi: [
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
    ],
    background: "#2e3440",
    cursor: "#d8dee9",
    foreground: "#d8dee9",
    selection: "#434c5e",
  },
};

/** Dracula, as its Kitty theme has it. MIT. https://github.com/dracula/kitty */
const dracula: Theme = {
  name: "dracula",
  palette: {
    ansi: [
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
    ],
    background: "#282a36",
    cursor: "#f8f8f2",
    foreground: "#f8f8f2",
    selection: "#44475a",
  },
};

/**
 * Tokyo Night, by Folke Lemaitre, as its terminal extras have the night style.
 * Apache-2.0. https://github.com/folke/tokyonight.nvim
 */
const tokyoNight: Theme = {
  name: "tokyo-night",
  palette: {
    ansi: [
      "#15161e",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#a9b1d6",
      "#414868",
      "#f7768e",
      "#9ece6a",
      "#e0af68",
      "#7aa2f7",
      "#bb9af7",
      "#7dcfff",
      "#c0caf5",
    ],
    background: "#1a1b26",
    cursor: "#c0caf5",
    foreground: "#c0caf5",
    selection: "#283457",
  },
};

/** Every theme iirc comes with, in the order a list shows them. */
export const builtInThemes: readonly Theme[] = [
  dark,
  light,
  solarizedDark,
  solarizedLight,
  gruvboxDark,
  nord,
  dracula,
  tokyoNight,
];
