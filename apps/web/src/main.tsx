import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme";
import "./style.css";
import "./refinement.css";
import "./graph.css";
import "./workspace.css";
import "./files.css";
import "./glass.css";
import "./product.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
