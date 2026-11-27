/**
 * The site table, as a value: how one hop of a fetch is asked of the site it reaches. Pure, so
 * every rule is a row in a table. Each rule's comment is the evidence for it: what the site
 * answered, and to which user agent or `Accept`.
 *
 * @packageDocumentation
 */
import type { Purpose } from "./link-fetch.ts";
import type { Target } from "./policy.ts";

/**
 * Which user agent a hop sends. `iirc` is the honest one, which names iirc and says it is a
 * bot. `crawler` also names iirc, beside the tokens link-preview crawlers send, for the sites
 * that serve anything else a page that needs a browser to run it.
 */
export type Agent = "iirc" | "crawler";

/**
 * Which `Accept` a hop sends: its purpose's own, or for a page that is likely media, one that
 * lists image, video, and audio types only, for the sites that answer HTML to any `Accept`
 * that names it.
 */
export type Accepting = "purpose" | "media";

/** How one hop is asked. */
export interface Asking {
  readonly agent: Agent;
  readonly accept: Accepting;
  /** The link to fetch in this one's place, for a page. Never itself rewritten. */
  readonly rewrite: string | undefined;
}

/**
 * A rewrite: a pattern matched against a link's name and its path and query written together,
 * as `name/path?query`, and what to fetch in its place, with `$<name>` for each of its named groups. Each
 * pattern starts at the start of the name and ends it at its `/`, so it names it whole.
 */
export interface Rewrite {
  readonly link: RegExp;
  readonly to: string;
}

/**
 * The table. A host is a name exactly, or `*.` and a name for every name under it, never one
 * that merely ends the same way.
 */
export interface Sites {
  /** Hosts that are sent the crawler agent. Every other host is sent iirc's own. */
  readonly crawler: readonly string[];
  /** Hosts whose pages are asked as media first. */
  readonly media: readonly string[];
  /** Extensions, lower-cased, that make a page's last path segment likely media. */
  readonly extensions: ReadonlySet<string>;
  /** A page's rewrites, the first that matches applied. */
  readonly rewrites: readonly Rewrite[];
}

/** The sites iirc asks otherwise than as itself, for a page, by the evidence beside each. */
export const sites: Sites = {
  crawler: [
    // The iirc agent gets an 8 KB proof-of-work page titled "Reddit". The crawler agent gets
    // the post's og tags.
    "reddit.com",
    "*.reddit.com",
    // The iirc agent gets a 1.4 KB shell with `x-tt-system-error: 3`. The crawler agent gets
    // the og tags.
    "tiktok.com",
    "*.tiktok.com",
    // Its bot list names crawlers only: the iirc agent gets no og tags, the crawler agent a
    // card with the post's text and video.
    "vxtwitter.com",
    // Redirects everyone to vxtwitter.com.
    "fixvx.com",
    // fxTikTok: og tags for the crawler and iirc agents alike, as TikTok's own pages are not.
    "tnktok.com",
  ],
  extensions: new Set([
    "apng",
    "avif",
    "bmp",
    "gif",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "webp",
    "m4v",
    "mov",
    "mp4",
    "ogv",
    "webm",
    "aac",
    "flac",
    "m4a",
    "mp3",
    "oga",
    "ogg",
    "opus",
    "wav",
  ]),
  media: [
    // Any `Accept` that names `text/html` or `*/*` gets a 302 to the image's HTML page. An
    // image `Accept` gets the image.
    "i.imgur.com",
    // `.jpg` and `.pnj` answer a 40 KB HTML page to an `Accept` that names `text/html`, and
    // the image to an image `Accept`.
    "*.media.tumblr.com",
  ],
  rewrites: [
    // `<blog>.tumblr.com/post/<id>` is a JavaScript challenge, a 403, to every agent tried.
    // `www.tumblr.com/<blog>/<id>` answers the post's og tags.
    {
      link: /^(?!www\.)(?<blog>[a-z0-9-]+)\.tumblr\.com\/post\/(?<id>\d+)(?:[/?].*)?$/su,
      to: "https://www.tumblr.com/$<blog>/$<id>",
    },
    // A `.gifv` asked as a page is a 302 to the post's HTML page. The `.mp4` of the same id is
    // the video.
    {
      link: /^i\.imgur\.com\/(?<id>[a-z0-9]+)\.gifv(?:\?.*)?$/isu,
      to: "https://i.imgur.com/$<id>.mp4",
    },
    // The iirc agent gets "Your browser is deprecated". `www.youtube.com/watch` answers the
    // video's og tags for the same query.
    {
      link: /^music\.youtube\.com\/watch(?<query>\?.*)?$/su,
      to: "https://www.youtube.com/watch$<query>",
    },
    // FxEmbed's fixupx.com answers any agent with `bot` in it the post's text and its video
    // as og tags, where x.com gives a crawler no text and no video to anyone.
    {
      link: /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/(?<user>\w{1,50})\/status\/(?<id>\d+)(?:[/?].*)?$/su,
      to: "https://fixupx.com/$<user>/status/$<id>",
    },
  ],
};

const iirc: Asking = { accept: "purpose", agent: "iirc", rewrite: undefined };

/**
 * Whether a name is one of a list's hosts: exactly, or under a `*.` entry by whole labels.
 * @param name - The name, lower-cased, without a trailing dot.
 * @param hosts - The hosts.
 * @returns Whether it is.
 */
const among = (name: string, hosts: readonly string[]) =>
  hosts.some((host) => (host.startsWith("*.") ? name.endsWith(host.slice(1)) : name === host));

/**
 * Whether a page's path ends in a segment with a media extension.
 * @param table - The table.
 * @param path - The path and query.
 * @returns Whether it does.
 */
const looksLikeMedia = (table: Sites, path: string) => {
  const segment = path.split("?")[0]?.split("/").at(-1) ?? "";
  const dot = segment.lastIndexOf(".");

  return dot !== -1 && table.extensions.has(segment.slice(dot + 1).toLowerCase());
};

/**
 * How one hop of a fetch is asked: by which agent, with which `Accept`, and for a page, at
 * which link in this one's place. A rewrite's link is asked as any other, but never rewritten
 * again.
 * @param table - The table.
 * @param target - The link, as the policy parsed it.
 * @param purpose - What it is fetched for.
 * @returns How to ask it.
 */
export const asking = (table: Sites, target: Target, purpose: Purpose): Asking => {
  if (target.literal !== undefined) {
    return iirc;
  }

  const name = target.hostname.replace(/\.$/u, "");
  const agent = among(name, table.crawler) ? "crawler" : "iirc";

  if (purpose.kind !== "page") {
    return { ...iirc, agent };
  }

  const written = `${name}${target.path}`;
  const rule = table.rewrites.find((each) => each.link.test(written));

  return {
    accept: among(name, table.media) || looksLikeMedia(table, target.path) ? "media" : "purpose",
    agent,
    rewrite: rule === undefined ? undefined : written.replace(rule.link, rule.to),
  };
};
