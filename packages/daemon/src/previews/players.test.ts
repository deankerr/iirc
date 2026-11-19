import { describe, expect, it } from "vitest";

import { playerOf, stillListed } from "./players.ts";
import type { PlayerCandidate } from "./read.ts";

const defaults = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "w.soundcloud.com",
  "bandcamp.com",
  "open.spotify.com",
  "player.twitch.tv",
];

const candidate = (link: string, size: PlayerCandidate["size"] = null): PlayerCandidate => ({
  link,
  size,
});

const link = (address: string, list: readonly string[] = defaults) =>
  playerOf([candidate(address)], list)?.link;

describe(playerOf, () => {
  it("gives each of the six services' embed hosts", () => {
    expect(
      [
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "https://player.vimeo.com/video/1",
        "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false",
        "https://bandcamp.com/EmbeddedPlayer/v=2/track=1/size=large/",
        "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
        "https://player.twitch.tv/?channel=twitch&parent=example.com",
      ].map((address) => link(address))
    ).toStrictEqual([
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://player.vimeo.com/video/1",
      "https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false",
      "https://bandcamp.com/EmbeddedPlayer/v=2/track=1/size=large/",
      "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC",
      "https://player.twitch.tv/?channel=twitch&parent=example.com",
    ]);
  });

  it("rewrites each YouTube host to youtube-nocookie, keeping its path and query", () => {
    expect(
      [
        "https://youtube.com/embed/abc?start=10&rel=0",
        "https://www.youtube.com/embed/abc?start=10&rel=0",
        "https://m.youtube.com/embed/abc?start=10&rel=0",
        "https://www.youtube-nocookie.com/embed/abc?start=10&rel=0",
      ].map((address) => link(address))
    ).toStrictEqual(
      Array.from({ length: 4 }, () => "https://www.youtube-nocookie.com/embed/abc?start=10&rel=0")
    );
  });

  it("matches a host exactly, so no look-alike plays", () => {
    expect(
      [
        "https://player.vimeo.com.evil.test/video/1",
        "https://evilplayer.vimeo.com/video/1",
        "https://sub.player.vimeo.com/video/1",
        "https://vimeo.com/video/1",
        "https://player.vimeo.com./video/1",
        "https://player.vimeo.com@evil.test/",
        "https://player.vimeo.com%2eevil.test/",
        "https://evil.test/player.vimeo.com",
        "https://evil.test/?u=https://player.vimeo.com/",
        "https://www.youtube.com.evil.test/embed/abc",
        "https://youtube.com.evil.test/embed/abc",
        "https://evil-youtube.com/embed/abc",
        "https://youtube-nocookie.com/embed/abc",
        "https://evil.youtube-nocookie.com/embed/abc",
        "https://www.youtube-nocookie.com.evil.test/embed/abc",
        "https://music.youtube.com/embed/abc",
        "https://PLAYER.VIMEO.COM.evil.test/",
      ].map((address) => link(address))
    ).toStrictEqual(Array.from({ length: 17 }).fill(undefined));
  });

  it("takes https alone, no credentials, and no port", () => {
    expect(
      [
        "http://player.vimeo.com/video/1",
        "https://user@player.vimeo.com/video/1",
        "https://user:pass@player.vimeo.com/video/1",
        "https://:pass@player.vimeo.com/video/1",
        "https://player.vimeo.com:8443/video/1",
        "https://player.vimeo.com:443/video/1x",
        "//player.vimeo.com/video/1",
        "ftp://player.vimeo.com/video/1",
        "gopher://player.vimeo.com/video/1",
        "not a url",
        "",
      ].map((address) => link(address))
    ).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "https://player.vimeo.com/video/1x",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("reads the host as the URL parser does, so a lower-cased or default-port address still matches", () => {
    expect([
      link("https://PLAYER.VIMEO.COM/video/1"),
      link("https://player.vimeo.com:443/video/1"),
    ]).toStrictEqual(["https://player.vimeo.com/video/1", "https://player.vimeo.com/video/1"]);
  });

  it("gives none for an empty list, even for YouTube", () => {
    expect([
      link("https://player.vimeo.com/video/1", []),
      link("https://www.youtube.com/embed/abc", []),
    ]).toStrictEqual([undefined, undefined]);
  });

  it("gives only the hosts a custom list names", () => {
    const list = ["videos.example.org"];

    expect([
      link("https://videos.example.org/embed/1", list),
      link("https://player.vimeo.com/video/1", list),
      link("https://www.youtube.com/embed/abc", list),
      link("https://other.videos.example.org/embed/1", list),
    ]).toStrictEqual(["https://videos.example.org/embed/1", undefined, undefined, undefined]);
  });

  it("is rewritten only when YouTube's rewritten host is listed too", () => {
    expect([
      link("https://www.youtube.com/embed/abc", ["www.youtube.com"]),
      link("https://www.youtube.com/embed/abc", ["www.youtube-nocookie.com"]),
    ]).toStrictEqual([undefined, "https://www.youtube-nocookie.com/embed/abc"]);
  });

  it("gives the first candidate that is a player, so a listed one after an unlisted one wins", () => {
    expect(
      playerOf(
        [
          candidate("https://cdn.evil.test/movie.mp4", { height: 1, width: 1 }),
          candidate("https://player.vimeo.com/video/1", { height: 360, width: 640 }),
          candidate("https://w.soundcloud.com/player/"),
        ],
        defaults
      )
    ).toStrictEqual({
      link: "https://player.vimeo.com/video/1",
      size: { height: 360, width: 640 },
    });
  });

  it("gives none when no candidate is a player, or there are none", () => {
    expect([
      playerOf([], defaults),
      playerOf([candidate("https://cdn.evil.test/movie.mp4")], defaults),
    ]).toStrictEqual([undefined, undefined]);
  });

  it("keeps a missing size as none, and the size of the candidate that was chosen", () => {
    expect(playerOf([candidate("https://player.vimeo.com/video/1")], defaults)?.size).toBeNull();
  });
});

describe(stillListed, () => {
  it("holds for a kept link whose host is listed now", () => {
    expect(stillListed("https://player.vimeo.com/video/1", defaults)).toBeTruthy();
    expect(stillListed("https://www.youtube-nocookie.com/embed/abc", defaults)).toBeTruthy();
  });

  it("fails once the host is no longer listed, or the list is empty", () => {
    expect([
      stillListed("https://player.vimeo.com/video/1", ["w.soundcloud.com"]),
      stillListed("https://player.vimeo.com/video/1", []),
    ]).toStrictEqual([false, false]);
  });

  it("holds to the same rules: no look-alike, no port, no credentials, no http", () => {
    expect(
      [
        "https://player.vimeo.com.evil.test/",
        "https://player.vimeo.com:8443/",
        "https://u@player.vimeo.com/",
        "http://player.vimeo.com/",
        "https://youtube-nocookie.com/embed/abc",
      ].map((address) => stillListed(address, defaults))
    ).toStrictEqual([false, false, false, false, false]);
  });
});
