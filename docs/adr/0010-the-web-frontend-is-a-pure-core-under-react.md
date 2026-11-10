# The web frontend is a pure core under a React view

The web frontend is a pure core with a thin React 19 view on top. The core folds News into Timelines, and holds the panes, focus, the command registry, the keymap, and the theme as plain data and reducers. An Effect runtime around the core follows News and calls the API, and React only subscribes to the core and renders it, through `@effect/atom-react`. Keeping the state out of the framework makes what a Frontend shows a projection that can be rebuilt, like the Client's State. It also means a different view layer would rewrite the views and nothing else. One registry of commands serves the palette, keybindings, `/commands`, and agents, because each is a way of naming the same action.

## Considered options

- **Foldkit** fits our principles best. Its `update` is a reducer, and it is built on Effect throughout. But it is pre-1.0, with frequent breaking releases and about one maintainer, and coding agents know little about it.
- **Solid** is the best fit for append-heavy Timelines. But 2.0 is still a release candidate, and Effect's Atom bindings support only 1.x.
- **Svelte 5** has no official Effect binding. SvelteKit's server rendering adds nothing to a client of a Daemon.

React carries the least risk, has the deepest libraries for keyboard and focus handling, and is the framework agents write best. t3code uses the same shape: streams folded by pure reducers into atoms, under a thin view.

## Consequences

- The core follows the same determinism rules as `@iirc/client`: no clock, no randomness, no I/O, and plain data only. It is tested with replay and property tests, without a DOM.
- Vite builds the frontend, as Vitest already runs on it. Bun builds the `iirc` binary, which embeds the built frontend for the shapes in [ADR 0007](0007-one-binary-shapes-by-argument.md).
- Every shape stays same-origin. A frontend served from another origin, as Glowing Bear is for WeeChat, is out of scope, because it would need a key held in browser script ([ADR 0006](0006-proportionate-security.md)).
- On the desktop, the frontend is an installable web app served by the Daemon. A native shell waits until something needs it.
