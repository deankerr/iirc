/**
 * The browser's history for tests: the page on an entry of its own after one of the page
 * before it, so a test can see whether Back leaves the page, and Back pressed as a browser's
 * button or a phone's gesture does, by a real `popstate`.
 *
 * @packageDocumentation
 */
import { act } from "react";

/** The state of the entry of the page before this one. */
const before = "the page before";

/**
 * Puts the page on an entry of its own, after an entry of the page before it.
 */
export const pageEntered = () => {
  history.pushState(before, "");
  history.pushState(null, "");
};

/**
 * Whether Back left the page: the history is on the entry of the page before it.
 * @returns Whether it did.
 */
export const left = () => history.state === before;

/**
 * Presses Back, with React drawing what it closes.
 */
export const back = async () => {
  await act(async () => {
    history.back();
    await Promise.resolve();
  });
};
