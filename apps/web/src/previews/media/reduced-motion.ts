/**
 * Whether this device is set to reduce motion, followed as it changes, and false where the
 * browser has no way to say.
 *
 * @packageDocumentation
 */
import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";

/**
 * Follows the device's setting.
 * @param changed - What to call when it changes.
 * @returns How to stop.
 */
const follow = (changed: () => void): (() => void) => {
  if (typeof matchMedia === "undefined") {
    return () => {
      // Nothing was followed.
    };
  }

  const media = matchMedia(query);

  media.addEventListener("change", changed);

  return () => {
    media.removeEventListener("change", changed);
  };
};

/**
 * The device's setting now.
 * @returns Whether it reduces motion.
 */
const reduces = (): boolean => typeof matchMedia !== "undefined" && matchMedia(query).matches;

/**
 * Whether this device is set to reduce motion.
 * @returns Whether it is, now and as it changes.
 */
export const useReducedMotion = (): boolean => useSyncExternalStore(follow, reduces, () => false);
