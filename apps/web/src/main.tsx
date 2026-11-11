/**
 * Starts the Frontend: one registry for every atom, a check of whether the browser is
 * signed in, the Timelines and the options under `ui` followed, the open one marked read,
 * and the open Channel and the nicks completion waits on read while it is, the page's
 * visibility and title watched, the theme in effect drawn, and React over them.
 *
 * @packageDocumentation
 */
import "./ui/theme.css";
import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/app.tsx";
import { channelSync } from "./channel/atoms.ts";
import { draftsCarried } from "./composer/atoms.ts";
import { chantypesSync, completer } from "./composer/completion.ts";
import { lookupSync } from "./lookup/atoms.ts";
import { optionsSync } from "./options/atoms.ts";
import { uiSync } from "./options/ui.ts";
import { watchPage } from "./page/watch.ts";
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

registry.mount(marking);

// The open Channel's head and members, and the nicks and CHANTYPES completion reads, likewise.
registry.mount(channelSync);

registry.mount(completer);

registry.mount(chantypesSync);

// What was typed under a draft goes to its Timeline once the draft shows it.
registry.mount(draftsCarried);

// Each Pane's Lookup card, let go of with its Pane, and every one on signing out.
registry.mount(lookupSync);

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
