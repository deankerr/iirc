// PROTOTYPE (#30): the knobs Dean can flip, kept in the address so a view can be shared.
import { createContext, useContext } from "react";

export const knobs = {
  fold: { label: "default", options: ["open", "folded"] },
  folded: { label: "folded as", options: ["summary", "toggle"] },
  page: { label: "page", options: ["thumb", "card", "line"] },
  frame: { label: "frame", options: ["rule", "box", "bare"] },
  size: { label: "media", options: ["s", "m", "l"] },
  several: { label: "several", options: ["stack", "row"] },
  pending: { label: "loading", options: ["line", "skeleton"] },
  failed: { label: "failed", options: ["plain", "mark"] },
  large: { label: "larger view", options: ["screen", "pane"] },
  layout: { label: "layout", options: ["one", "split", "narrow", "phone"] },
  theme: { label: "theme", options: ["auto", "light", "dark"] },
  referrer: { label: "player referrer", options: ["none", "origin"] },
  notes: { label: "notes", options: ["on", "off"] },
} as const;

export type Knob = keyof typeof knobs;
export type Variants = { readonly [K in Knob]: (typeof knobs)[K]["options"][number] };

export const fromSearch = (search: string): Variants => {
  const params = new URLSearchParams(search);
  const entries = Object.entries(knobs).map(([key, knob]) => {
    const asked = params.get(key);
    const options: readonly string[] = knob.options;
    return [key, asked !== null && options.includes(asked) ? asked : options[0]];
  });
  return Object.fromEntries(entries) as Variants;
};

export const toSearch = (variants: Variants): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(variants)) {
    if (value !== knobs[key as Knob].options[0]) {
      params.set(key, value);
    }
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
};

export const VariantsContext = createContext<Variants>(fromSearch(""));
export const useVariants = () => useContext(VariantsContext);

/** Opens the larger view, over the screen or over the Pane, as the variant says. */
export interface Large {
  readonly kind: "image" | "video";
  readonly src: string;
  readonly poster?: string;
  readonly width: number;
  readonly height: number;
  readonly href: string;
}

export const LargeContext = createContext<(large: Large) => void>(() => undefined);
