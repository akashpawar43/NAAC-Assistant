import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev, the API runs on :8080 (npm run dev) and Vite proxies /api to it (API_PORT overrides).
const api = `http://localhost:${process.env.API_PORT ?? 8080}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: api,
        // The API refuses state-changing requests from origins other than its own (CSRF defence),
        // and the browser sends Origin: http://localhost:5173. Through this dev-only proxy the
        // request really does come from the app, so it is presented as same-origin.
        configure: (proxy) =>
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", api);
          }),
      },
    },
  },
});
