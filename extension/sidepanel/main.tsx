import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyTheme, readThemeMode } from "./theme.ts";

applyTheme(readThemeMode());

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
