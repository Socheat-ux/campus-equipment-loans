import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  // Vite only sets NODE_ENV when it is unset, so a shell or host NODE_ENV=development would bundle development React.
  if (command === "build") process.env.NODE_ENV = "production";
  return {
    root: fileURLToPath(new URL("./frontend", import.meta.url)), // absolute, so Vite works from any folder
    // envDir stays at frontend/ (no .env there): the root .env is for the server, and its NODE_ENV must not reach the build.
    build: { outDir: "../dist", emptyOutDir: true },
    plugins: [react()],
    server: { proxy: { "/api": "http://localhost:3000" } },
  };
});
