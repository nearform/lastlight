import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard is served at the server root (`/`), and during `npm run dev` it
// proxies the data endpoints to a running harness server (`lastlight-evals serve`
// or an in-flight `run`), so HMR works against live JSON.
const API_PORT = process.env.LASTLIGHT_EVALS_PORT ?? "4319";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, cssMinify: "esbuild" },
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5174),
    proxy: {
      "/api": `http://localhost:${API_PORT}`,
      "/data": `http://localhost:${API_PORT}`,
    },
  },
});
