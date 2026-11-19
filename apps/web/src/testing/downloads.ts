/**
 * What a test sees of the downloads a page starts: each press on a link made to save a file
 * is kept, with where it went, and goes no further, as a browser would have saved it.
 *
 * @packageDocumentation
 */
import { vi } from "vitest";

/** A download a page started: the link's address, as written, and whether it asked to save. */
export interface Download {
  readonly href: string | null;
  readonly saves: boolean;
}

/**
 * Starts keeping the downloads the page starts. `vi.restoreAllMocks` stops it.
 * @returns Each one, in order.
 */
export const watchDownloads = (): readonly Download[] => {
  const started: Download[] = [];

  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(
    this: HTMLAnchorElement
  ) {
    started.push({ href: this.getAttribute("href"), saves: this.hasAttribute("download") });
  });

  return started;
};
