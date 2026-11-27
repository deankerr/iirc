# A link is asked as its site answers it

A stranger's link is fetched under iirc's own, honest user agent, which names iirc and says it is a bot. A pure table of rules, matched by host name and never as a substring, lets a site be asked otherwise where its answer to that agent has nothing a Preview can use: it may send a crawler's agent, ask a page for media first, or fetch the page at another link that answers it. Every rule carries the evidence for it beside it, and the table applies to each hop of a fetch, redirect targets included, so a shortened link is asked as the site it reaches. We chose this because no single way of asking works everywhere, and a rule per site is small, testable as a table, and honest about why each exception exists.

A crawler's agent everywhere would be simpler, and it unlocks the sites that serve a page that needs a browser to anything that is not a crawler. But it costs as much as it gains. X sends a crawler a post with no text, a CDN that checks claimed crawlers resets the connection, and an image host sends a crawler an HTML wrapper in place of the image. So it is an opt-in, per host, and it still names iirc. A browser's agent is worse: a link shortener sends a browser a page that redirects by script, which is never run, and FxEmbed sends a browser on to the very site it stands in for.

An X post is fetched from FxEmbed's `fixupx.com`, which answers a bot with the post's text and its video, where X gives the text to some agents only and the video to none. This makes X Previews depend on a third party staying up and keeping its answers as they are. We accept that for the richer Preview, and a failure there is a failed Preview like any other.

## Consequences

- A rule is a fact about one site at one time, and goes stale when the site changes. Its evidence beside it says what to check again.
- A rewritten Preview names the site that answered, not the one the Message carried.
- FxEmbed learns each X post the Owner is shown a Preview of, and the address that asked for it. We accept that for X alone, where no other way of asking answers with the post.
