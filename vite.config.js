import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL("./frontend", import.meta.url)), // absolute, so Vite works from any folder
  // envDir stays at frontend/ (no .env there): the root .env is for the server, and its NODE_ENV must not reach the build.
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
