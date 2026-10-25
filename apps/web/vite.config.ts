import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    {
      name: "landing-root",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          const incoming = request as typeof request & { url?: string };
          const url = incoming.url ?? "";
          if (url.split("?", 1)[0] === "/") {
            incoming.url = "/landing/index.html" + url.slice(1);
          }
          next();
        });
      },
    },
    react(),
  ],
  server: {
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8081", changeOrigin: false } },
  },
  build: { chunkSizeWarningLimit: 4000 },
});
