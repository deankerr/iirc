/**
 * Starts the Frontend: one registry for every atom, a check of whether the browser is
 * signed in, the Timelines and the options under `ui` followed, the open one marked read,
 * and the open Channel and the nicks completion waits on read while it is, the page's
 * visibility and title watched, the theme in effect drawn, and React over them.
 *
 * @packageDocumentation
 */
import "./ui/theme.css";
import "./theme/fonts.css";
import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/app.tsx";
import { channelSync } from "./channel/atoms.ts";
import { draftsCarried } from "./composer/atoms.ts";
import { chantypesSync, completer } from "./composer/completion.ts";
import { uploadsSignedOut } from "./composer/uploading.ts";
import { lookupSync } from "./lookup/atoms.ts";
import { nickMenuSync } from "./nick/atoms.ts";
import { optionsSync } from "./options/atoms.ts";
import { ownerSync } from "./options/owner.ts";
import { uiSync } from "./options/ui.ts";
import { uploadsSync } from "./options/uploads.ts";
import { watchPage } from "./page/watch.ts";
import { previewsSync } from "./previews/atoms.ts";
import { marking } from "./reading/atoms.ts";
import { check } from "./sign-in/atoms.ts";
import { watchTheme } from "./theme/atoms.ts";
import { sync } from "./timelines/atoms.ts";

const registry = AtomRegistry.make({ scheduleTask });

// Whether the browser is signed in is asked once, here, before anything renders, and the
// Timelines are read and followed whenever it is, for as long as the page is open.
registry.set(check, undefined);

registry.mount(sync);

registry.mount(uiSync);

// What the options show is read each time they come to show, however they came to.
registry.mount(optionsSync);

// The options under store, uploads, and previews are followed while they show, as nothing else draws on them.
registry.mount(ownerSync);

// The Uploads listed beside them likewise.
registry.mount(uploadsSync);

registry.mount(marking);

// The open Channel's head and members, and the nicks and CHANTYPES completion reads, likewise.
registry.mount(channelSync);

registry.mount(completer);

registry.mount(chantypesSync);

// The Previews of the Messages shown, asked for and followed while `ui.previews` asks.
registry.mount(previewsSync);

// What was typed under a draft goes to its Timeline once the draft shows it.
registry.mount(draftsCarried);

// Whether the User of the menu open on a nick is in its Channel.
registry.mount(nickMenuSync);

// Each Pane's Lookup card, let go of with its Pane, and every one on signing out.
registry.mount(lookupSync);

// Every file uploading from the composers, and its preview, let go of on signing out.
registry.mount(uploadsSignedOut);

// Whether the Owner can see the page, and its title, kept in one place for its whole life.
watchPage(registry);

// The theme in effect, drawn from its palette as custom properties on the root.
watchTheme(registry);

const root = document.querySelector("#root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <RegistryContext.Provider value={registry}>
        <App />
      </RegistryContext.Provider>
    </StrictMode>
  );
}
