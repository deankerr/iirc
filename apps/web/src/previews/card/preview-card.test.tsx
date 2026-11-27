// @vitest-environment happy-dom
import type {
  CardShown,
  LinkCardShown,
  MediaShown,
  PictureShown,
  PlayerShown,
  SoundShown,
  VideoShown,
} from "@iirc/frontend/previews";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  drawn,
  framesGoNowhere,
  happened,
  observing,
  pressed,
  restored,
  scrolledNear,
  settled,
  stubMedia,
} from "../media/testing/browser.tsx";
import { PreviewCard } from "./preview-card.tsx";

// React warns about updates outside `act` unless told this is a test.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const link = { href: "https://example.com/cats", text: "https://example.com/cats" };
const stream = "/api/previews/cats/stream?timeline=t&position=p";
const host = "www.youtube-nocookie.com";

/**
 * A picture the Daemon kept.
 * @param animated - Whether it moves.
 * @returns It.
 */
const picture = (animated = false): PictureShown => ({
  _tag: "Picture",
  alt: "Cats",
  animated,
  dimensions: undefined,
  src: "/api/previews/images/cats",
});

/**
 * A video the Daemon streams.
 * @param poster - Its poster, if any.
 * @param src - Where it streams from.
 * @returns It.
 */
const video = (poster?: PictureShown, src = stream): VideoShown => ({
  _tag: "Video",
  box: { height: 9, width: 16 },
  poster,
  src,
  type: "video/mp4",
});

const sound: SoundShown = { _tag: "Sound", src: stream, type: "audio/ogg" };

const player: PlayerShown = {
  _tag: "Player",
  box: { height: 360, width: 640 },
  host,
  poster: undefined,
  src: `https://${host}/embed/abc123?autoplay=1`,
  words: `plays from ${host}`,
};

/**
 * A link card about cats.
 * @param media - Its media.
 * @returns It.
 */
const cats = (media: MediaShown): LinkCardShown => ({
  _tag: "LinkCard",
  description: "A page about cats.",
  key: "0",
  link,
  media,
  name: "Cats",
  title: "Cats",
});

/**
 * Draws a card, its expanded state kept under one link's key.
 * @param card - The card.
 * @returns The page.
 */
const drawCard = async (card: CardShown) => {
  const page = await drawn(<PreviewCard card={card} held="cats" />);

  return {
    ...page,
    again: async (next: CardShown) => {
      await page.draw(<PreviewCard card={next} held="cats" />);
    },
  };
};

/**
 * The card as drawn.
 * @returns It, or none.
 */
const card = () => document.body.querySelector<HTMLElement>('[data-preview="ready"]');

/**
 * The card's expand button.
 * @returns It, or none.
 */
const expandButton = () =>
  card()?.querySelector<HTMLButtonElement>('button[aria-label^="full preview of"]');

/**
 * A button in the card by its accessible name.
 * @param name - Its name.
 * @returns It, or none.
 */
const button = (name: string) =>
  card()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

/**
 * The card's thumbnail.
 * @returns It, or none.
 */
const thumbnail = () => card()?.querySelector<HTMLElement>("[data-thumb]");

/**
 * The card's words.
 * @returns Each part's text.
 */
const words = () => [...(card()?.querySelectorAll("bdi") ?? [])].map((part) => part.textContent);

/**
 * How the card stands: collapsed or expanded, and what its button says.
 * @returns It.
 */
const standing = () => ({
  expanded: expandButton()?.getAttribute("aria-expanded"),
  layout: card()?.dataset.layout,
});

/**
 * Clicks an element, as a pointer does, which a card hears as it bubbles.
 * @param element - The element.
 */
const clicked = async (element: Element | null | undefined) => {
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
};

/**
 * What plays in the card: a video or a sound and whether it started at once, or a player's
 * frame.
 * @returns It, or none.
 */
const playing = () => {
  const media = card()?.querySelector("video, audio");

  if (media instanceof HTMLMediaElement) {
    return { autoplay: media.autoplay, src: media.getAttribute("src") };
  }

  return card()?.querySelector("iframe") === null ? null : "frame";
};

/** Lays the card's words out as running past the lines they are cut to. */
const wordsCut = () => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.localName === "bdi" ? 40 : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.localName === "bdi" ? 20 : 0;
    },
  });
};

describe("a link card", () => {
  beforeEach(() => {
    observing();
  });

  afterEach(() => {
    restored();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
  });

  // Catches a card that offers to expand when expanding would show nothing more.
  it("is inert with no media and words that fit: no button, and a click expands nothing", async () => {
    await drawCard(cats({ _tag: "None" }));
    await clicked(card()?.querySelector("bdi"));

    expect({ ...standing(), buttons: card()?.querySelectorAll("button").length }).toStrictEqual({
      buttons: 0,
      expanded: undefined,
      layout: "collapsed",
    });
  });

  // Catches a stranger's words drawn as markup.
  it("draws its words as text, never as markup", async () => {
    const lines = "<b>x</b>\n<img src=x onerror=alert(1)>";

    await drawCard({ ...cats({ _tag: "None" }), description: lines });

    expect({ elements: card()?.querySelectorAll("b, img").length, words: words() }).toStrictEqual({
      elements: 0,
      words: ["Cats", lines],
    });
  });

  // Catches cut words the Owner has no way to read whole.
  it("with words cut, expands on its button and collapses on a click of the card, its button keeping one name", async () => {
    wordsCut();
    await drawCard(cats({ _tag: "None" }));

    const collapsed = { ...standing(), name: expandButton()?.getAttribute("aria-label") };

    await pressed(expandButton());

    const expanded = { ...standing(), name: expandButton()?.getAttribute("aria-label") };

    await clicked(card()?.querySelector("bdi"));

    expect({ again: standing(), collapsed, expanded }).toStrictEqual({
      again: { expanded: "false", layout: "collapsed" },
      collapsed: { expanded: "false", layout: "collapsed", name: "full preview of Cats" },
      expanded: { expanded: "true", layout: "expanded", name: "full preview of Cats" },
    });
  });

  // Catches a thumbnail fetched far from the view, or a still picture as a second tab stop.
  it("draws a still picture's thumbnail cropped from the Daemon's copy, once near, as no button of its own", async () => {
    await drawCard(cats(picture()));

    const far = thumbnail()?.querySelector("img");

    await scrolledNear();

    expect({
      buttons: [...(card()?.querySelectorAll("button") ?? [])].map((one) =>
        one.getAttribute("aria-label")
      ),
      far,
      src: thumbnail()?.querySelector("img")?.getAttribute("src"),
      tag: thumbnail()?.localName,
    }).toStrictEqual({
      buttons: ["full preview of Cats"],
      far: null,
      src: "/api/previews/images/cats",
      tag: "span",
    });
  });

  // Catches an avatar a page calls a thumbnail offered as something to expand.
  it("is inert with a picture its page calls a thumbnail and words that fit, the thumbnail drawn", async () => {
    await drawCard(cats({ _tag: "ThumbnailOnly", picture: picture() }));

    expect({ button: expandButton() ?? null, thumbnail: thumbnail() !== null }).toStrictEqual({
      button: null,
      thumbnail: true,
    });
  });

  // Catches that avatar drawn large, or dropped, once the card's cut words expand.
  it("keeps a picture its page calls a thumbnail as the thumbnail, with no larger one, once its cut words expand", async () => {
    wordsCut();
    await drawCard(cats({ _tag: "ThumbnailOnly", picture: picture() }));
    await pressed(expandButton());
    await scrolledNear();

    expect({
      ...standing(),
      pictures: card()?.querySelectorAll("img").length,
      thumbnail: thumbnail()?.querySelector("img")?.getAttribute("src"),
    }).toStrictEqual({
      expanded: "true",
      layout: "expanded",
      pictures: 1,
      thumbnail: "/api/previews/images/cats",
    });
  });

  // Catches an animated picture moving in a collapsed card.
  it("draws an animated picture's thumbnail as its first frame, still", async () => {
    stubMedia();
    await drawCard(cats(picture(true)));
    await scrolledNear();
    await settled(() => thumbnail()?.querySelector("canvas") !== null);

    expect(thumbnail()?.querySelector("img")).toBeNull();
  });

  // Catches a click on the card that streams what nobody pressed play on.
  it("expands only on a click of the card: a video rests under its poster, and nothing plays", async () => {
    await drawCard(cats(video(picture())));
    await scrolledNear();
    await clicked(card()?.querySelector("bdi"));
    await scrolledNear();

    expect({ ...standing(), play: button("play Cats") !== null, playing: playing() }).toStrictEqual(
      { expanded: "true", layout: "expanded", play: true, playing: null }
    );
  });

  // Catches a thumbnail that plays opening the card without playing, or leaving focus behind.
  it.each([
    ["a video with a poster", cats(video(picture())), "play Cats", { autoplay: true, src: stream }],
    ["a video with none", cats(video()), "play Cats", { autoplay: true, src: stream }],
    ["a sound", cats(sound), "play Cats", { autoplay: true, src: stream }],
    ["a player", cats(player), `play from ${host}`, "frame"],
  ] as const)(
    "expands and plays %s at once from its thumbnail, leaving focus on its button",
    async (_, shown, name, plays) => {
      framesGoNowhere();
      await drawCard(shown);
      await pressed(button(name));

      expect({
        ...standing(),
        focused: document.activeElement === expandButton(),
        playing: playing(),
        thumbnail: thumbnail(),
      }).toStrictEqual({
        expanded: "true",
        focused: true,
        layout: "expanded",
        playing: plays,
        thumbnail: null,
      });
    }
  );

  // Catches media that plays on after its card collapses, or plays again unpressed.
  it("stops what plays as it collapses, and plays nothing as it expands again", async () => {
    await drawCard(cats(video()));
    await pressed(button("play Cats"));

    const played = playing();

    await pressed(expandButton());

    const collapsed = { ...standing(), playing: playing() };

    await pressed(expandButton());

    expect({ again: playing(), collapsed, played }).toStrictEqual({
      again: { autoplay: false, src: stream },
      collapsed: { expanded: "false", layout: "collapsed", playing: null },
      played: { autoplay: true, src: stream },
    });
  });

  // Catches a press of the media, or the end of a selection, collapsing the card under it.
  it("stays expanded on a click of its media, a control, or one that ends a selection of its words", async () => {
    await drawCard(cats(video()));
    await pressed(expandButton());
    await clicked(card()?.querySelector("video"));
    await clicked(card()?.querySelector("[data-card-media]"));

    const words = card()?.querySelector("bdi");

    if (words !== null && words !== undefined) {
      document.getSelection()?.selectAllChildren(words);
    }

    await clicked(card()?.querySelector("bdi"));

    const kept = standing();

    document.getSelection()?.removeAllRanges();
    await clicked(card()?.querySelector("bdi"));

    expect({ after: standing(), kept }).toStrictEqual({
      after: { expanded: "false", layout: "collapsed" },
      kept: { expanded: "true", layout: "expanded" },
    });
  });

  // Catches a press in the lightbox collapsing the card behind it, which closes the lightbox.
  it("stays expanded, its lightbox open, on a click in the lightbox", async () => {
    await drawCard(cats(video()));
    await pressed(expandButton());
    await pressed(button("enlarge Cats"));
    await settled(() => document.body.querySelector('[role="dialog"]') !== null);
    await clicked(document.body.querySelector('[role="dialog"] video'));
    await clicked(document.body.querySelector('[role="dialog"] a'));

    expect({
      ...standing(),
      lightbox: document.body.querySelector('[role="dialog"] video') !== null,
    }).toStrictEqual({ expanded: "true", layout: "expanded", lightbox: true });
  });

  // Catches a row scrolled away and back losing what the Owner expanded, or playing again.
  it("stays expanded when drawn again, but plays nothing until pressed", async () => {
    const { again, draw } = await drawCard(cats(video()));

    await pressed(button("play Cats"));
    // The row scrolls away, and back.
    await draw(<div />);
    await again(cats(video()));

    expect({ ...standing(), playing: playing() }).toStrictEqual({
      expanded: "true",
      layout: "expanded",
      playing: { autoplay: false, src: stream },
    });
  });

  // Catches media the Daemon answers anew starting to play though nobody pressed it.
  it("plays nothing the Daemon answers anew with other media", async () => {
    const other = `${stream}&again`;
    const { again } = await drawCard(cats(video()));

    await pressed(button("play Cats"));
    await again(cats(video(undefined, other)));

    expect(playing()).toStrictEqual({ autoplay: false, src: other });
  });

  // Catches a video starting again unpressed as its Timeline goes to `text` and back to `on`.
  it("plays nothing when its media is taken away and given back", async () => {
    const { again } = await drawCard(cats(video()));

    await pressed(button("play Cats"));
    await again(cats({ _tag: "None" }));
    await again(cats(video()));

    expect({ ...standing(), playing: playing() }).toStrictEqual({
      expanded: "true",
      layout: "expanded",
      playing: { autoplay: false, src: stream },
    });
  });

  describe("whose media fails", () => {
    // Catches a broken image left as an empty square, or a card that expands to nothing.
    it("leaves its words alone, with nothing to expand, once its picture fails as a thumbnail", async () => {
      await drawCard(cats(picture()));
      await scrolledNear();
      await happened(thumbnail()?.querySelector("img"), "error");

      expect({ button: expandButton(), thumbnail: thumbnail(), words: words() }).toStrictEqual({
        button: null,
        thumbnail: null,
        words: ["Cats", "A page about cats."],
      });
    });

    // Catches a broken image left under an expanded card's words.
    it("leaves its words alone once its picture fails expanded", async () => {
      await drawCard(cats(picture()));
      await pressed(expandButton());
      await scrolledNear();
      await happened(card()?.querySelector("[data-card-media] img"), "error");

      expect({ media: card()?.querySelector("[data-card-media]"), words: words() }).toStrictEqual({
        media: null,
        words: ["Cats", "A page about cats."],
      });
    });

    // Catches a failed poster taking its video with it.
    it("keeps the play glyph once its poster fails, which still expands and plays", async () => {
      await drawCard(cats(video(picture())));
      await scrolledNear();
      await happened(thumbnail()?.querySelector("img"), "error");

      const glyph = { img: thumbnail()?.querySelector("img"), thumb: thumbnail()?.dataset.thumb };

      await pressed(button("play Cats"));

      expect({ glyph, playing: playing() }).toStrictEqual({
        glyph: { img: null, thumb: "poster" },
        playing: { autoplay: true, src: stream },
      });
    });

    // Catches a video that cannot play leaving a dead player under the words.
    it("leaves its words alone once its video fails to play", async () => {
      await drawCard(cats(video()));
      await pressed(button("play Cats"));
      await happened(card()?.querySelector("video"), "error");

      expect({ media: card()?.querySelector("[data-card-media]"), words: words() }).toStrictEqual({
        media: null,
        words: ["Cats", "A page about cats."],
      });
    });
  });
});

describe("a media card", () => {
  beforeEach(() => {
    observing();
  });

  afterEach(() => {
    restored();
  });

  const catVideo: CardShown = {
    _tag: "MediaCard",
    key: "0",
    link,
    media: video(),
    name: link.text,
  };

  // Catches a link that is itself a video collapsing, or streaming before it is pressed.
  it("is its media alone, resting, with nothing to expand", async () => {
    await drawCard(catVideo);

    expect({
      button: expandButton(),
      layout: card()?.dataset.layout,
      preload: card()?.querySelector("video")?.getAttribute("preload"),
      words: words(),
    }).toStrictEqual({ button: null, layout: "media", preload: "none", words: [] });
  });

  // Catches a failed link that is itself media leaving an empty row behind.
  it("draws nothing once its media fails", async () => {
    const { container } = await drawCard(catVideo);

    await happened(card()?.querySelector("video"), "error");

    expect(container.childElementCount).toBe(0);
  });
});
