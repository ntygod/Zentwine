import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;
function launch(command, args, cwd = root) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    detached: process.platform !== "win32",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env: {
      ...process.env,
      NODE_ENV: "development",
      ZENTWINE_HOST: "127.0.0.1",
      ZENTWINE_API_PORT: "4100",
    },
  });
  children.add(child);
  child.once("error", () => {
    console.error("Unable to start a development process");
    shutdown(1);
  });
  child.once("exit", () => children.delete(child));
  return child;
}
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const running = [...children];
  for (const child of running)
    if (child.pid) {
      if (process.platform === "win32")
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* Already exited. */
        }
      }
    }
  const force = setTimeout(() => {
    for (const child of running)
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    process.exit(code);
  }, 5000);
  Promise.all(
    running.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve)),
    ),
  )
    .then(() => {
      clearTimeout(force);
      process.exit(code);
    })
    .catch(() => process.exit(1));
}
process.once("SIGINT", () => shutdown());
process.once("SIGTERM", () => shutdown());
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(new Error(`Port ${port} is already in use`)),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
async function wait(url) {
  const end = Date.now() + 20000;
  while (Date.now() < end && !stopping) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Development services did not become live");
}
async function main() {
  for (const port of [4100, 5173, 5174]) await freePort(port);
  if (!process.argv.includes("--no-build")) {
    const child = launch(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
      "build",
    ]);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    if (code !== 0) throw new Error("Build failed");
  }
  const preview = process.argv.includes("--preview");
  const api = launch(process.execPath, ["services/api/dist/main.js"]);
  const frontend = ["workbench", "studio"].map((name, index) =>
    launch(
      process.execPath,
      [
        path.join(root, "apps", name, "node_modules/vite/bin/vite.js"),
        ...(preview ? ["preview"] : []),
        "--host",
        "127.0.0.1",
        "--port",
        String(5173 + index),
        "--strictPort",
      ],
      path.join(root, "apps", name),
    ),
  );
  for (const child of [api, ...frontend])
    child.once("exit", () => {
      if (!stopping) {
        console.error("A development service exited; stopping all services");
        shutdown(1);
      }
    });
  await Promise.all([
    wait("http://127.0.0.1:4100/livez"),
    wait("http://127.0.0.1:5173"),
    wait("http://127.0.0.1:5174"),
  ]);
  console.log(
    "\nWorkbench http://127.0.0.1:5173/org/local/workbench\nStudio    http://127.0.0.1:5174/org/local/studio\nDevelopment only. Ctrl+C stops all child processes. No Agent execution.\n",
  );
}
main().catch((error) => {
  console.error(error.message);
  shutdown(1);
});
