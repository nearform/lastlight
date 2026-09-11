import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
// Self-hosted faces. Inter used to come from the rsms.me CDN, and JetBrains
// Mono was named in `--font-mono` but never loaded at all — so every mono
// surface silently fell back to `ui-monospace`. Bundling both fixes the missing
// face and drops an external network dependency from an admin UI that routinely
// runs behind a strict egress allowlist.
//
// Imported HERE rather than with `@import` in index.css: Tailwind inlines a CSS
// `@import` during its own pass, which loses the source file's context, so Vite
// never rewrites the relative `./files/*.woff2` URLs and emits no font assets.
// A JS import goes through Vite's asset pipeline and resolves correctly.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
