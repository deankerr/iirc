# @iirc/web

The web frontend: a React 19 view over [`@iirc/frontend`](../../packages/frontend/README.md), its pure core ([ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md)), built with Vite. It is a Frontend like any other, and reaches the Daemon only through [`@iirc/api`](../../packages/api/README.md), which the lint fence enforces. It is served on the API's own origin, by `iirc daemon --web` ([ADR 0007](../../docs/adr/0007-one-binary-shapes-by-argument.md)).

```sh
bun run build:web                                        # at the root: apps/web/dist
bun run iirc daemon --data-dir ~/.local/share/iirc --web apps/web/dist
```

## What it does

- **Signs in with a key.** On load it asks whether the browser is signed in, with one authorized read, `GET /api/networks`. Signed out, it asks for a key and gives it to `POST /api/sign-in` once, for a sign-in the browser holds in an `HttpOnly` cookie. Why a sign-in failed is said in words: a wrong key, a request from another origin, the Daemon unable to save its sign-ins, or the Daemon not answering, with a way to try again.
- **Shows the Networks** the Daemon runs, by id, with whether each is running or why it stopped.
- **Signs out** with `DELETE /api/sign-in`, which clears the cookie.

## How it is built

| Folder | Holds |
| --- | --- |
| `src/app/` | The shell, the one Effect runtime, and the Daemon's client |
| `src/sign-in/` | The sign-in atoms and commands, and the sign-in screen |
| `src/networks/` | The Networks' atom and their list |
| `src/ui/` | The theme's tokens, a button on React Aria Components, and a password field that holds no value |

- **One Effect runtime.** `Atom.runtime` provides `DaemonClient`, which is `HttpApiClient.make(DaemonApi)` over the browser's `fetch`, with relative URLs, so every request goes to the origin that served the page and carries its cookie. Every atom that reaches the Daemon runs in it, and a test replaces its Layer through `runtime.layer`.
- **State lives in atoms, not components.** The sign-in state is one atom holding the core's `SignIn`, and the commands `check`, `signInWithKey`, and `signOut` are `runtime.fn` atoms that fold each answer in as an event. Components read atoms and run commands. None fetches, and none writes state from an effect. `src/main.tsx` runs `check` once, before the first render.
- **What can be derived is.** The Networks' atom is read again whenever the browser becomes signed in, and a read refused as `Unauthorized` folds `Refused`, so a sign-in ended elsewhere signs the page out.
- **Styles are CSS Modules over the theme.** `src/ui/theme.css` holds every colour, size, and font as a CSS variable, dark and light by `prefers-color-scheme`, and no module names a colour of its own. Each module's class names are declared in a `.module.d.css.ts` beside it, so a class that does not exist fails to compile.

## What it guarantees

- **The Frontend never stores a key** ([ADR 0006](../../docs/adr/0006-proportionate-security.md)). While the Owner types it, the key is held only by the input, as any password field holds it, and nothing in the page keeps it once it has been sent. The input is a plain, uncontrolled `<input type="password">`, so the key is never in React state or props: React Aria's fields keep every keystroke in state, so a secret never goes through one, and React Aria is used where nothing secret is held. On submit, the form is read in one expression and parsed as the API's own `SignInRequest`, straight to `Redacted`. Each field's value is then set to `""`, which also clears the last value React DOM's tracker keeps on every input, controlled or not, and the form is reset, whether the sign-in then succeeds or fails. The sign-in command wipes the `Redacted` once the Daemon has answered, so the argument its atom keeps holds nothing. Nothing is written to `localStorage`, `sessionStorage`, or a cookie script can read.
- **The key field is accessible and a password manager may keep it.** It has a `<label>`, is required, and while a sign-in has failed it is `aria-invalid` and `aria-describedby` the failure's words. Its `autocomplete` is `current-password`, so a password manager can fill in and save the key: that is the Owner's own choice and outside the page's script, and a key held there is no worse than one pasted from a file.
- **It runs under a strict Content Security Policy.** It loads nothing but its own files, with no inline script or style. React Aria would inject one inline `<style>` for its pressable elements, so `public/pressable.css` carries the same rule and is linked under the id React Aria looks for, which stops it injecting.
- **Every failure is decided from the API's structure.** A typed error, a request that got no answer, or a gateway's `502` or `504`, never the text of a response.

## Development

```sh
bun run dev          # in apps/web: Vite on localhost:5173
```

The dev server proxies `/api` to a Daemon on `127.0.0.1:7667`, so the browser sees one origin. The proxy passes the browser's `Host` and `Origin` through unchanged, so the Daemon sees requests as same-origin, and it streams responses, Server-Sent Events included, without buffering. A Daemon that is not running is answered `502`, which the Frontend reads as no answer.

## Tests

`bun run test` runs two files, sharing the fake Daemon in `src/testing/fake-daemon.ts`.

`src/sign-in/sign-in-screen.test.tsx` renders the Frontend in happy-dom and types a key as a keystroke does, the value set beneath React's tracking and an `input` event after. It walks everything React keeps from its root, state and props, and everything the atom registry holds, for the key. It also reads React DOM's value tracker on the input directly, since it keeps the last value typed in a closure no walk reaches. It covers a key held by neither while typed, and, after a failed sign-in, the field empty, its tracker holding `""`, neither holding the key, and the failure shown and tied to the field, and after a sign-in, the same. Put React Aria's `TextField` in place of the field and the first fails, since it holds the key while typed. Drop the explicit clear before the reset and both fail, since the tracker keeps the key.

`src/sign-in/atoms.test.ts`: the atoms and commands against a fake Daemon at the `fetch` level, through the real `DaemonClient` and the API's own decoding. It covers a browser with no sign-in found signed out, signing in with the key and reading the Networks, the key wiped once answered and sent once, a wrong key said as one and wiped too, the Daemon unable to save the sign-in, signing out and staying signed in when that fails, a refused read signing the page out, and a Daemon that does not answer, directly or through a gateway, checked again once it does.

The browser runs end to end in `apps/iirc`'s `bun run e2e`, against the built frontend on a real `iirc daemon --web`.

## Not yet

- **Timelines, the composer, News, panes, the command palette, the options pane, and theming,** which [ADR 0010](../../docs/adr/0010-the-web-frontend-is-a-pure-core-under-react.md), [ADR 0012](../../docs/adr/0012-the-web-frontend-builds-on-react-aria-and-resizable-panels.md), and [ADR 0013](../../docs/adr/0013-configuration-is-an-option-tree.md) describe.
- **Splitting the bundle.** It is one script of about 520 kB, 170 kB gzipped, most of it Effect and React Aria, and Vite warns past 500 kB.
- **An installable web app,** with a manifest and an icon.
