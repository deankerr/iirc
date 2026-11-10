/**
 * Starts the Frontend: one registry for every atom, a check of whether the browser is
 * signed in, and React over both.
 *
 * @packageDocumentation
 */
import "./ui/theme.css";
import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/app.tsx";
import { check } from "./sign-in/atoms.ts";

const registry = AtomRegistry.make({ scheduleTask });

// Whether the browser is signed in is asked once, here, before anything renders.
registry.set(check, undefined);

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
