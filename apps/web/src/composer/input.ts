/**
 * How the page finds the composer's textarea, which the one key listener moves the focus to
 * as the Owner types, in the very key press that types.
 *
 * @packageDocumentation
 */

/**
 * The main composer's textarea, which carries `data-composer`, if the page has one drawn.
 * @param root - The document to look in.
 * @returns It, or none.
 */
export const composerInput = (root: Document): HTMLTextAreaElement | undefined =>
  root.querySelector<HTMLTextAreaElement>("textarea[data-composer]") ?? undefined;
