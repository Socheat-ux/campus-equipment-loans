import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "frontend",
  envDir: "..", // .env and dist/ stay at the repo root
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
