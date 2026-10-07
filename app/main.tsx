// global.css first: page stylesheets (imported by the pages via App) must come later in the cascade.
import "./styles/global.css";
import "./styles/setup.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppProvider } from "./state";
import { ToastProvider } from "./components/ui";
import { loadStudio } from "./lib/studio";

// The studio's name and wordmark first (one small request), then the app.
void loadStudio().then(() =>
  createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
  ),
);
