// PROTOTYPE (#30): a throwaway page of faked Previews in a rough Timeline. Never merged.
import "../../ui/theme.css";
import "../../theme/fonts.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";

const root = document.querySelector("#root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
