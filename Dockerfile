# iirc as an image: the Daemon with the web frontend built in, as apps/iirc/README.md says.
# Built from a checkout and never published: docker compose build, or docker build -t iirc .

# The Bun that package.json pins, which compiles the executable as build:iirc does.
FROM oven/bun:1.4.5-slim AS build
WORKDIR /src
COPY . .
# No lifecycle scripts: they set up lint and git hooks, which the build needs neither of.
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build:iirc

# The executable carries its own runtime, so the image needs nothing else from Bun.
FROM debian:trixie-slim
# The Daemon's own user, never root. The data directory is owner-only and its, so a fresh
# named volume mounted over it takes that ownership, and needs no chown.
RUN useradd --uid 1000 --user-group --no-create-home --home-dir /var/lib/iirc \
      --shell /usr/sbin/nologin iirc \
  && install -d -m 0700 -o iirc -g iirc /var/lib/iirc
COPY --from=build /src/dist/iirc /usr/local/bin/iirc
USER iirc:iirc
# The API and the web frontend, then the Link listener, once uploads.listen names it.
EXPOSE 7667 7668
ENTRYPOINT ["/usr/local/bin/iirc"]
# Every address inside the container: the Compose file decides what the machine publishes.
CMD ["daemon", "--data-dir", "/var/lib/iirc", "--listen", "0.0.0.0:7667", "--web"]
