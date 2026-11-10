# One binary; shapes chosen by argument

iirc ships as one executable, `iirc`, and its arguments choose what it runs: a Daemon, a Daemon with the web frontend, or the web frontend alone as a proxy to a Daemon. Static files in `dist/` behind any reverse proxy are a fourth shape. A build flag only decides whether web assets are included. Separate executables per shape would save nothing, because the Bun runtime alone is about 104 MB and a web frontend adds about 2 MB. Every shape is same-origin, which settles how a browser holds its key: it exchanges it once for an `HttpOnly` cookie.

## Consequences

| Shape | Command | Runs | Exists |
| --- | --- | --- | --- |
| Stand-alone Daemon | `iirc daemon` | The Daemon and its API | Yes |
| Daemon with web frontend | `iirc daemon --web` | The same, plus static routes on one origin | Not yet |
| Stand-alone web frontend | `iirc web --daemon-url <url>` | Static routes, and a proxy to a Daemon's `/api` | Not yet |
| Static files | `dist/` behind any reverse proxy | Nothing of ours at run time | Not yet |

- A reverse proxy serving `dist/` also forwards `/api`, so the static shape is same-origin too.
- Everything sits under `/api`, so a mistyped path cannot fall through to the web frontend and return HTML.
- The Daemon never knows a web frontend exists. A web frontend is a Layer that adds routes, and only `apps/iirc` knows both.
- A build without web assets refuses `--web` and `iirc web` with a clear error. Only a guarded `import()` removes assets, because a static import stays in the binary with the feature off.
- `iirc key create`, `iirc config`, `iirc credential`, and `iirc backup` live in the same executable. All but the first are Frontends of the API.
- A test harness is a separate executable, because it tests the Daemon and isn't a shape of it.
