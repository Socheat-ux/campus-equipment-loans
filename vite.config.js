import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL("./frontend", import.meta.url)), // absolute, so Vite works from any folder
  envDir: "..", // .env and dist/ stay at the repo root
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
