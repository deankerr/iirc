/**
 * Lint rules the fence needs that oxlint does not have.
 *
 * @packageDocumentation
 */

interface Node {
  readonly type: string;
}

interface Context {
  readonly report: (problem: { readonly message: string; readonly node: Node }) => void;
}

/** The fence's own rules, loaded by `oxlint.config.ts` as the `fence` plugin. */
const plugin = {
  meta: { name: "fence" },
  rules: {
    // `import()` loads a module the import rules cannot see by name, such as the whole
    // `effect` barrel. Fenced code has no need to load a module lazily.
    "no-dynamic-import": {
      create: (context: Context) => ({
        ImportExpression: (node: Node) => {
          context.report({
            message: "Fenced code imports statically, so the fence can see what it imports.",
            node,
          });
        },
      }),
    },
  },
};

export default plugin;
