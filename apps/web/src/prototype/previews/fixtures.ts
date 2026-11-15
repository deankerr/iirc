// PROTOTYPE (#30): hard-coded Timelines and Previews, shaped as #24 decided.

export interface Picture {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export type Preview =
  | {
      readonly kind: "page";
      readonly title?: string;
      readonly description?: string;
      readonly site?: string;
      readonly image?: Picture;
    }
  | { readonly kind: "image"; readonly image: Picture; readonly animated?: boolean }
  | { readonly kind: "video"; readonly poster: Picture; readonly duration: string }
  | { readonly kind: "audio"; readonly src: string; readonly duration: string }
  | {
      readonly kind: "player";
      readonly title: string;
      readonly site: string;
      readonly poster: Picture;
      readonly frame: { readonly src: string; readonly host: string; readonly width: number; readonly height: number };
    };

export type Reason = "refused" | "unreachable" | "timed out" | "too large" | "nothing to show";

export type State =
  | { readonly _tag: "Ready"; readonly preview: Preview }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Waiting"; readonly then: Preview }
  | { readonly _tag: "Failed"; readonly reason: Reason };

export type Segment = string | { readonly href: string };

export type Row =
  | {
      readonly _tag: "Message";
      readonly id: string;
      readonly time: string;
      readonly nick: string;
      readonly colour: number;
      readonly text: readonly Segment[];
      readonly highlight?: boolean;
      /** What this case shows, for whoever is reacting to it. */
      readonly note?: string;
    }
  | { readonly _tag: "Activity"; readonly id: string; readonly time: string; readonly marker: string; readonly text: string };

const p = (src: string, width: number, height: number): Picture => ({
  height,
  src: `/prototype/${src}`,
  width,
});

/** Each link's Preview, by its address. */
export const previews: ReadonlyMap<string, State> = new Map<string, State>([
  [
    "https://github.com/deankerr/iirc",
    {
      _tag: "Ready",
      preview: {
        description:
          "An always-on IRC client you can build on: a library, a headless Daemon, and a web frontend, each good enough to stand alone.",
        image: p("og-repo.svg", 1200, 630),
        kind: "page",
        site: "GitHub",
        title: "deankerr/iirc: An always-on IRC client you can build on",
      },
    },
  ],
  ["https://i.imgur.com/ferry.jpeg", { _tag: "Ready", preview: { image: p("landscape.svg", 1200, 800), kind: "image" } }],
  [
    "https://media.giphy.com/media/orbit/giphy.gif",
    { _tag: "Ready", preview: { animated: true, image: p("orbit.gif", 320, 200), kind: "image" } },
  ],
  [
    "https://video.example.org/glow.mp4",
    { _tag: "Ready", preview: { duration: "0:05", kind: "video", poster: p("poster-video.svg", 1280, 720) } },
  ],
  [
    "https://files.example.net/chime.wav",
    { _tag: "Ready", preview: { duration: "0:03", kind: "audio", src: "/prototype/chime.wav" } },
  ],
  [
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
    {
      _tag: "Ready",
      preview: {
        frame: {
          height: 720,
          host: "youtube.com",
          src: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1",
          width: 1280,
        },
        kind: "player",
        poster: p("poster-player.svg", 1280, 720),
        site: "YouTube",
        title: "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film",
      },
    },
  ],
  [
    "https://en.wikipedia.org/wiki/Internet_Relay_Chat",
    {
      _tag: "Ready",
      preview: {
        description:
          "IRC is a text-based chat system for instant messaging. IRC is designed for group communication in discussion forums, called channels, but also allows one-on-one communication via private messages.",
        image: p("diagram.svg", 900, 500),
        kind: "page",
        site: "Wikipedia",
        title: "IRC - Wikipedia",
      },
    },
  ],
  [
    "https://blog.example.com/ssrf-in-link-previews",
    {
      _tag: "Ready",
      preview: {
        description:
          "Checking a name and then fetching by name is the bug. Pin the address you checked, follow redirects one at a time, and check each.",
        image: p("og-article.svg", 1200, 630),
        kind: "page",
        site: "a blog about networks",
        title: "Link previews are an SSRF waiting to happen",
      },
    },
  ],
  [
    "https://mastodon.social/@ircv3/113140",
    {
      _tag: "Ready",
      preview: {
        description: "message-tags and server-time are now in every major Ircd we know of. Next up: chathistory.",
        image: p("avatar-mastodon.svg", 400, 400),
        kind: "page",
        site: "Mastodon",
        title: "IRCv3 (@ircv3@mastodon.social)",
      },
    },
  ],
  ["https://i.imgur.com/tall.png", { _tag: "Ready", preview: { image: p("portrait.svg", 800, 1200), kind: "image" } }],
  ["https://slow.example.com/quarterly-report", { _tag: "Pending" }],
  ["https://down.example.com/status", { _tag: "Failed", reason: "timed out" }],
  ["http://192.168.1.10/admin", { _tag: "Failed", reason: "refused" }],
  [
    "https://ircv3.net/",
    {
      _tag: "Ready",
      preview: {
        description: "The IRCv3 Working Group is a collaboration between client and server developers to add new features to IRC.",
        kind: "page",
        site: "ircv3.net",
        title: "IRCv3 Working Group",
      },
    },
  ],
  [
    "https://www.youtube.com/watch?v=dQw-mara",
    {
      _tag: "Waiting",
      then: {
        frame: {
          height: 720,
          host: "youtube.com",
          src: "https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?autoplay=1",
          width: 1280,
        },
        kind: "player",
        poster: p("poster-player.svg", 1280, 720),
        site: "YouTube",
        title: "the one I told you about",
      },
    },
  ],
  [
    "https://i.imgur.com/mara-dog.jpeg",
    { _tag: "Waiting", then: { image: p("landscape.svg", 1200, 800), kind: "image" } },
  ],
]);

const link = (href: string) => ({ href });

export const channel: readonly Row[] = [
  { _tag: "Activity", id: "a1", marker: "-->", text: "ada (~ada@user/ada) has joined #iirc", time: "09:12" },
  { _tag: "Message", colour: 5, id: "m1", nick: "ada", text: ["morning all"], time: "09:12" },
  {
    _tag: "Message",
    colour: 9,
    id: "m2",
    nick: "ben",
    note: "a page: title, description, site, image",
    text: ["the repo is public now ", link("https://github.com/deankerr/iirc")],
    time: "09:14",
  },
  {
    _tag: "Message",
    colour: 1,
    id: "m3",
    nick: "cyd",
    note: "an image",
    text: ["sunset from the ferry ", link("https://i.imgur.com/ferry.jpeg")],
    time: "09:15",
  },
  {
    _tag: "Message",
    colour: 12,
    id: "m4",
    nick: "dee",
    note: "an animated image, still until pressed",
    text: ["mood ", link("https://media.giphy.com/media/orbit/giphy.gif")],
    time: "09:15",
  },
  { _tag: "Message", colour: 5, id: "m5", nick: "ada", text: ["ha"], time: "09:16" },
  {
    _tag: "Message",
    colour: 5,
    id: "m6",
    nick: "ada",
    note: "a video: poster, plays on a press",
    text: ["the bay was glowing last night ", link("https://video.example.org/glow.mp4")],
    time: "09:17",
  },
  {
    _tag: "Message",
    colour: 9,
    id: "m7",
    nick: "ben",
    note: "a sound",
    text: ["made a doorbell for the bot ", link("https://files.example.net/chime.wav")],
    time: "09:19",
  },
  {
    _tag: "Message",
    colour: 1,
    id: "m8",
    nick: "cyd",
    note: "a player: poster, nothing loads before a press",
    text: ["for the test video: ", link("https://www.youtube.com/watch?v=aqz-KE-bpKQ")],
    time: "09:21",
  },
  { _tag: "Activity", id: "a2", marker: "--", text: "ben is now known as benji", time: "09:22" },
  {
    _tag: "Message",
    colour: 12,
    id: "m9",
    nick: "dee",
    note: "four links: only the first three previewed",
    text: [
      "reading list ",
      link("https://en.wikipedia.org/wiki/Internet_Relay_Chat"),
      " ",
      link("https://blog.example.com/ssrf-in-link-previews"),
      " ",
      link("https://mastodon.social/@ircv3/113140"),
      " and the spec ",
      link("https://ircv3.net/specs/extensions/message-tags"),
    ],
    time: "09:24",
  },
  {
    _tag: "Message",
    colour: 1,
    id: "m10",
    nick: "cyd",
    note: "a tall image",
    text: ["portrait mode ", link("https://i.imgur.com/tall.png")],
    time: "09:26",
  },
  {
    _tag: "Message",
    colour: 9,
    id: "m11",
    nick: "benji",
    note: "still loading",
    text: [link("https://slow.example.com/quarterly-report"), " is taking forever to load for me too"],
    time: "09:27",
  },
  {
    _tag: "Message",
    colour: 12,
    id: "m12",
    nick: "dee",
    note: "failed: a plain link, its reason on hover",
    text: ["is ", link("https://down.example.com/status"), " down? and why does ", link("http://192.168.1.10/admin"), " not preview"],
    time: "09:28",
  },
  {
    _tag: "Message",
    colour: 5,
    highlight: true,
    id: "m13",
    nick: "ada",
    note: "a page with no image, in a Highlight",
    text: ["dean: start at ", link("https://ircv3.net/")],
    time: "09:30",
  },
  {
    _tag: "Message",
    colour: 12,
    id: "m14",
    nick: "dee",
    text: [
      "the thing I like about this is that the Timeline still reads as a log: you can skim the left column and every Message is one line until something asks for more room",
    ],
    time: "09:31",
  },
  { _tag: "Message", colour: 7, id: "m15", nick: "dean", text: ["agreed, keep it calm"], time: "09:32" },
];

export const direct: readonly Row[] = [
  { _tag: "Message", colour: 3, id: "d1", nick: "mara", text: ["hey, saw your talk"], time: "08:40" },
  { _tag: "Message", colour: 7, id: "d2", nick: "dean", text: ["thanks! which bit?"], time: "08:41" },
  {
    _tag: "Message",
    colour: 3,
    id: "d3",
    nick: "mara",
    note: "a Direct Message: waits for a press",
    text: ["this bit ", link("https://www.youtube.com/watch?v=dQw-mara")],
    time: "08:43",
  },
  {
    _tag: "Message",
    colour: 3,
    id: "d4",
    nick: "mara",
    text: ["and my dog says hi ", link("https://i.imgur.com/mara-dog.jpeg")],
    time: "08:44",
  },
  { _tag: "Message", colour: 7, id: "d5", nick: "dean", text: ["ha, will look"], time: "08:46" },
];

/** At most three links in a Message are previewed (#24). */
export const previewed = (row: Extract<Row, { _tag: "Message" }>): readonly string[] =>
  row.text.flatMap((segment) => (typeof segment === "string" ? [] : [segment.href])).slice(0, 3);
