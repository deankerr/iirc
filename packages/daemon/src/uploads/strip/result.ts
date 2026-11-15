/**
 * What stripping gives: the bytes to keep, or why the image could not be walked.
 *
 * A file whose structure breaks before its image data is `Unreadable`, never kept as it
 * came, since what it holds is unknown. One cut short after its image data began keeps
 * what was walked whole, which holds nothing unknown.
 */
export type Stripped =
  | { readonly _tag: "Stripped"; readonly bytes: Uint8Array }
  | { readonly _tag: "Unreadable"; readonly reason: string };

/**
 * The bytes to keep.
 * @param bytes - The stripped image.
 * @returns A `Stripped`.
 */
export const stripped = (bytes: Uint8Array): Stripped => ({ _tag: "Stripped", bytes });

/**
 * Why the image could not be walked.
 * @param reason - What broke.
 * @returns An `Unreadable`.
 */
export const unreadable = (reason: string): Stripped => ({ _tag: "Unreadable", reason });
