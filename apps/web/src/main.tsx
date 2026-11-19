// Starts the web app and picks the page from the address (console, phone, studio, reports).

import "@fontsource-variable/public-sans";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Device } from "./Device";
import { Report } from "./Report";
import { Studio } from "./Studio";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.startsWith("/studio") ? (
      <Studio />
    ) : location.pathname.startsWith("/device") ? (
      <Device />
    ) : location.pathname.startsWith("/report") ? (
      <Report />
    ) : (
      <App />
    )}
  </StrictMode>,
);
