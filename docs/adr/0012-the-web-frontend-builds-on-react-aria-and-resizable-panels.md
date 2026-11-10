# The web frontend builds on React Aria and resizable panels

The web frontend takes its accessible parts from React Aria Components, styles everything with CSS Modules over theme tokens held in CSS variables, and renders panes with `react-resizable-panels`. Keyboard handling, focus, and resizing are the hard, detailed parts of a keyboard-first interface, and we would rather not write them ourselves. React Aria has the deepest keyboard and focus handling of the headless libraries, and it is the only one with a Tree for the sidebar. It also has an Autocomplete with a Menu for the command palette, and hooks for building our own widgets. Base UI is simpler and has more momentum, but it lacks those parts.

## Consequences

- The core owns the pane layout, as a split tree in a pure reducer, and `react-resizable-panels` only renders it and resizes it. Its `Group`, `Panel`, and `Separator` render each split, and a resize the Owner makes goes back to the core as a command. Its `Workspace`, which owns a layout model of its own, is not used, because two copies of the layout would need syncing.
- There is no router. Several panes are open at once, and a URL can describe only one, so the layout is kept per device and restored on reload. Jumping to a position is a command, which links and search results run too.
- Styles are CSS Modules, with no runtime cost, and a theme is a set of CSS variables.
