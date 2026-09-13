import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import { initTelemetry } from "./telemetry/sentry";
import "./styles/globals.css";

// Inert without VITE_SENTRY_DSN; strictly redacted when configured.
void initTelemetry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
