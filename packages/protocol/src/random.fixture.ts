/**
 * A small deterministic generator, so that a failure can be replayed from its seed.
 * @param seed - Where the sequence starts.
 * @returns A function giving the next whole number below `limit`.
 */
export const seededRandom = (seed: number) => {
  // Park and Miller's generator. Every product stays below 2^53, so none loses precision,
  // and the sequence runs 2^31 - 2 steps before it repeats.
  const modulus = 2_147_483_647;
  let state = (Math.abs(Math.trunc(seed)) % (modulus - 1)) + 1;

  return (limit: number) => {
    state = (state * 48_271) % modulus;

    return Math.floor(((state - 1) / (modulus - 1)) * limit);
  };
};

/**
 * Random text drawn from a small alphabet, so that the characters a parser cares about
 * turn up together far more often than they would in noise.
 * @param random - The generator.
 * @param alphabet - Each entry is one piece of text, such as a code or a digit.
 * @param length - How many pieces to join.
 * @returns The joined text.
 */
export const randomText = (
  random: (limit: number) => number,
  alphabet: readonly string[],
  length: number
) => Array.from({ length }, () => alphabet[random(alphabet.length)] ?? "").join("");
