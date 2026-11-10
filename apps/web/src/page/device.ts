/**
 * What this device keeps of the Owner's choices for it, in `localStorage`, as best it can.
 * Storage can be refused, as in a private window, or missing, as outside a browser, so a
 * choice read fails to nothing and one written may hold for the page only.
 *
 * @packageDocumentation
 */

/**
 * A choice kept on this device.
 * @param key - Its key, such as `iirc.members`.
 * @returns Its text, or none when it was never kept or cannot be read.
 */
export const readChoice = (key: string): string | undefined => {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

/**
 * Keeps a choice on this device, or forgets it.
 * @param key - Its key.
 * @param value - Its text, or none to forget it.
 * @returns Whether it was kept.
 */
export const writeChoice = (key: string, value: string | undefined): boolean => {
  try {
    if (value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }

    return true;
  } catch {
    return false;
  }
};
