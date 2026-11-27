import { Result } from "effect";
import { describe, expect, it } from "vitest";

import type { Purpose } from "./link-fetch.ts";
import { fixedPolicy, parseLink } from "./policy.ts";
import { asking, sites } from "./sites.ts";

const page: Purpose = { kind: "page" };
const image: Purpose = { kind: "image" };

/**
 * How a link is asked for a purpose, written short: its agent, its `Accept`, and any rewrite.
 * @param link - The link.
 * @param purpose - What it is fetched for.
 * @returns How it is asked.
 */
const asked = (link: string, purpose: Purpose = page) => {
  const target = parseLink(fixedPolicy, link);

  if (Result.isFailure(target)) {
    throw new Error(`refused: ${target.failure.reason}`);
  }

  return asking(sites, target.success, purpose);
};

const plain = { accept: "purpose", agent: "iirc", rewrite: undefined };
const crawler = { ...plain, agent: "crawler" };
const media = { ...plain, accept: "media" };

describe("the agent", () => {
  it.each([
    ["https://reddit.com/r/a", crawler],
    ["https://www.reddit.com/r/a/comments/1/x/", crawler],
    ["https://old.reddit.com/r/a", crawler],
    ["https://www.reddit.com./r/a", crawler],
    ["https://www.tiktok.com/@someone", crawler],
    ["https://vxtwitter.com/a/status/1", crawler],
    ["https://fixvx.com/a/status/1", crawler],
    ["https://tnktok.com/@someone", crawler],
    ["https://notreddit.com/r/a", plain],
    ["https://reddit.com.example/r/a", plain],
    ["https://redd.it/abc", plain],
    ["https://www.vxtwitter.com.evil/a", plain],
    ["https://fixupx.com/a/status/1", plain],
    ["https://example.com/", plain],
    ["http://93.184.215.14/", plain],
  ])("%s is asked as %o", (link, expected) => {
    expect(asked(link)).toStrictEqual(expected);
  });

  it("is the crawler's for any purpose", () => {
    expect(asked("https://i.reddit.com/x.png", image)).toStrictEqual(crawler);
  });
});

describe("the accept", () => {
  it.each([
    ["https://i.imgur.com/vAlnYQ3.jpg", media],
    ["https://i.imgur.com/vAlnYQ3", media],
    ["https://64.media.tumblr.com/a/b-90/s1280x1920/c.jpg", media],
    ["https://64.media.tumblr.com/a/b-90/s1280x1920/c.pnj", media],
    ["https://example.com/a/photo.PNG", media],
    ["https://example.com/clip.webm?t=3", media],
    ["https://example.com/song.mp3", media],
    ["https://example.com/a.jpg/", plain],
    ["https://example.com/jpg", plain],
    ["https://example.com/page.html", plain],
    ["https://example.com/?file=a.jpg", plain],
    ["https://imgur.com/vAlnYQ3", plain],
    ["https://media.tumblr.com.example/c.html", plain],
  ])("%s is asked as %o", (link, expected) => {
    expect(asked(link)).toStrictEqual(expected);
  });

  it("is the purpose's own for anything but a page", () => {
    expect(asked("https://i.imgur.com/vAlnYQ3.jpg", image)).toStrictEqual(plain);
  });
});

describe("rewrites", () => {
  it.each([
    [
      "https://mono-red-menace.tumblr.com/post/804859924490452992",
      "https://www.tumblr.com/mono-red-menace/804859924490452992",
    ],
    [
      "https://ccgscans.tumblr.com/post/123/a-slug?source=share",
      "https://www.tumblr.com/ccgscans/123",
    ],
    ["https://i.imgur.com/tfgwzwf.gifv", "https://i.imgur.com/tfgwzwf.mp4"],
    [
      "https://music.youtube.com/watch?v=T4lzzPzhXl0&si=x",
      "https://www.youtube.com/watch?v=T4lzzPzhXl0&si=x",
    ],
    [
      "https://x.com/Zoma3mk/status/2125635842521563147",
      "https://fixupx.com/Zoma3mk/status/2125635842521563147",
    ],
    ["https://twitter.com/a_b/status/1?s=20", "https://fixupx.com/a_b/status/1"],
    ["https://www.x.com/a/status/1/photo/1", "https://fixupx.com/a/status/1"],
    ["https://mobile.twitter.com/a/status/1", "https://fixupx.com/a/status/1"],
  ])("%s is fetched as %s", (link, rewrite) => {
    const first = asked(link);

    expect(first.rewrite).toBe(rewrite);
    expect(asked(rewrite).rewrite).toBeUndefined();
  });

  it.each([
    "https://www.tumblr.com/post/1",
    "https://www.tumblr.com/tomoleary",
    "https://a.b.tumblr.com/post/1",
    "https://blog.tumblr.com/tagged/post",
    "https://64.media.tumblr.com/f5/9c-90/s1280x1920/69.jpg",
    "https://i.imgur.com/tfgwzwf.mp4",
    "https://imgur.com/tfgwzwf.gifv",
    "https://music.youtube.com/playlist?list=1",
    "https://www.youtube.com/watch?v=1",
    "https://x.com/user",
    "https://x.com/user/status/notanumber",
    "https://notx.com/a/status/1",
    "https://x.com.example/a/status/1",
    "https://fixupx.com/a/status/1",
  ])("%s is not rewritten", (link) => {
    expect(asked(link).rewrite).toBeUndefined();
  });

  it("applies to a page only", () => {
    expect(asked("https://i.imgur.com/tfgwzwf.gifv", { kind: "stream" }).rewrite).toBeUndefined();
  });
});
