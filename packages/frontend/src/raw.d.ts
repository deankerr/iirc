// Vitest reads a file's text with `?raw`, so tests read vectors and fixtures without I/O.
declare module "*?raw" {
  const text: string;
  export default text;
}
