// Starts the API (port 3000, restarts on server changes) and the Vite app (port 5173) in one terminal: npm run dev:all
// Ctrl+C stops both. If either one exits, the other is stopped too, so nothing keeps a port busy.
import { spawn } from "node:child_process";

const start = (args) => spawn(process.execPath, args, { stdio: "inherit" });
const children = [
  start(["--env-file-if-exists=.env", "--watch", "server/index.js"]),
  start(["node_modules/vite/bin/vite.js", "--strictPort"]),
];

const stopAll = () => children.forEach((child) => child.exitCode === null && child.kill());
for (const child of children) {
  child.on("exit", (code) => {
    stopAll();
    process.exitCode ||= code ?? 0;
  });
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
