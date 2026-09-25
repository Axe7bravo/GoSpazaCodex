import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "..");
const apps = ["backend", "customer", "merchant", "driver", "admin"];
const windows = process.platform === "win32";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function observeClose(children, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.all(children.map((entry) => entry.closed)).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

// Invoke pnpm's JS entry through Node (or its standalone executable), never a
// .cmd/.bat shim. pnpm still owns the unchanged workspace dev scripts.
async function packageManager() {
  const inherited = process.env.npm_execpath;
  if (inherited && /pnpm\.(?:c?js|exe)$/i.test(inherited) && await exists(inherited)) {
    return inherited.endsWith(".exe") ? [inherited] : [process.execPath, inherited];
  }
  const directories = [...new Set([
    path.join(repository, "node_modules", ".bin"),
    process.env.PNPM_HOME,
    path.dirname(process.execPath),
    ...(process.env.PATH || "").split(path.delimiter).map((entry) => entry.replace(/^"|"$/g, "")),
  ].filter(Boolean))];
  for (const directory of directories) {
    for (const relative of ["pnpm.cjs", "node_modules/pnpm/bin/pnpm.cjs", "node_modules/corepack/dist/pnpm.js"]) {
      const candidate = path.join(directory, relative);
      if (await exists(candidate)) return [process.execPath, candidate];
    }
    if (windows && await exists(path.join(directory, "pnpm.exe"))) return [path.join(directory, "pnpm.exe")];
    if (!windows && await exists(path.join(directory, "pnpm"))) {
      const candidate = await realpath(path.join(directory, "pnpm"));
      if (/\.(?:c?js|mjs)$/.test(candidate)) return [process.execPath, candidate];
      return [path.join(directory, "pnpm")];
    }
  }
  throw new Error("Cannot locate pnpm. Install the repository's pinned pnpm version, then retry. No shell shim was launched.");
}

function prefixOutput(stream, destination, app) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const write = (text) => {
    pending += text;
    const lines = pending.split(/\r\n|\r|\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) destination.write("[" + app + "] " + line + "\n");
    // Bound buffering for programs that never emit a newline.
    if (pending.length > 8192) {
      destination.write("[" + app + "] " + pending + "\n");
      pending = "";
    }
  };
  stream.on("data", (chunk) => write(decoder.write(chunk)));
  stream.on("end", () => {
    write(decoder.end());
    if (pending) destination.write("[" + app + "] " + pending + "\n");
  });
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function killWindowsTree(pid) {
  return new Promise((resolve) => {
    let killer;
    try { killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
      shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    }); } catch (error) { resolve({ ok: false, detail: error.message }); return; }
    const timeout = setTimeout(() => { killer.kill(); resolve({ ok: false, detail: "taskkill timed out" }); }, 10000);
    killer.once("close", () => clearTimeout(timeout));
    killer.once("error", () => clearTimeout(timeout));
    let diagnostic = "";
    killer.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-4000); });
    killer.once("error", (error) => resolve({ ok: false, detail: error.message }));
    killer.once("close", (code) => resolve({ ok: code === 0, detail: diagnostic.trim() || "taskkill exit " + code }));
  });
}

// This launcher stays alive after pnpm exits. Its PID remains a valid Windows
// tree root / POSIX process-group leader until the parent finishes cleanup.
async function launcher(app) {
  if (!apps.includes(app) || !process.send) throw new Error("App launchers must be started by the supervisor.");
  // Retain the tree root even after both pnpm and the parent IPC channel close.
  setInterval(() => {}, 60000);
  const send = (message) => { if (process.connected) process.send(message, () => {}); };
  let orphanCleanup = false;
  const cleanOrphan = () => {
    if (orphanCleanup) return;
    orphanCleanup = true;
    if (windows) {
      const killer = spawn(taskkill, ["/PID", String(process.pid), "/T", "/F"], {
        detached: true, shell: false, windowsHide: true, stdio: "ignore",
      });
      killer.on("error", (error) => { process.stderr.write("Orphan tree cleanup failed: " + error.message + "\n"); process.exitCode = 1; });
      killer.unref();
    } else {
      signalGroup(process.pid, "SIGTERM");
      setTimeout(() => signalGroup(process.pid, "SIGKILL"), 4000);
    }
  };
  // The supervisor signals/kills the entire group; retain the anchor during grace.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  process.on("disconnect", cleanOrphan);
  process.on("message", () => {}); // Keep IPC referenced even after the dev script exits.
  process.on("uncaughtException", (error) => send({ event: "failure", detail: error.message }));
  process.on("unhandledRejection", (error) => send({ event: "failure", detail: String(error) }));
  try {
    const [command, ...prefix] = await packageManager();
    if (!process.connected) return;
    const child = spawn(command, [...prefix, "--filter", "@gospaza/" + app, "run", "dev"], {
      cwd: repository, shell: false, windowsHide: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? "1" },
    });
    child.once("spawn", () => send({ event: "started", pid: child.pid }));
    child.once("error", (error) => send({ event: "failure", detail: error.message }));
    child.once("exit", (code, signal) => send({ event: "exit", code, signal }));
  } catch (error) { send({ event: "failure", detail: error.message }); }
}

async function supervise() {
  await packageManager(); // Fail clearly before starting any applications.
  process.stdout.write("[supervisor] PID " + process.pid + " — Ctrl+C stops all five applications.\n");
  const children = [];
  let shutdownPromise;
  let requested = false;
  let exitCode = 0;
  function shutdown(reason, code) {
    if (requested) return shutdownPromise;
    requested = true;
    exitCode = code;
    process.stdout.write("[supervisor] " + reason + "; stopping all development trees.\n");
    // Defer cleanup until assignment makes repeated signals harmless.
    shutdownPromise = Promise.resolve().then(async () => {
      const targets = children.filter((entry) => entry.process.pid);
      if (windows) {
        await Promise.all(targets.map(async (entry) => {
          const result = await killWindowsTree(entry.process.pid);
          if (!result.ok) {
            process.stderr.write("[supervisor] " + entry.app + " tree cleanup could not be confirmed: " + result.detail + "\n");
            exitCode = 1;
          }
        }));
      } else {
        for (const entry of targets) {
          try { signalGroup(entry.process.pid, "SIGTERM"); }
          catch (error) { process.stderr.write("[supervisor] " + entry.app + ": " + error.message + "\n"); exitCode = 1; }
        }
        await delay(4000);
        for (const entry of targets) {
          try { signalGroup(entry.process.pid, "SIGKILL"); }
          catch (error) { process.stderr.write("[supervisor] " + entry.app + ": " + error.message + "\n"); exitCode = 1; }
        }
      }
      // Observe launcher close (including inherited output pipes), with a bound
      // so a failed OS cleanup cannot hang the controlling terminal indefinitely.
      const complete = await observeClose(children, 8000);
      if (!complete) {
        process.stderr.write("[supervisor] Timed out waiting for child termination; inspect remaining processes and ports.\n");
        exitCode = 1;
      }
      process.stdout.write("[supervisor] " + (exitCode === 0 ? "Development trees stopped." : "Stopped with errors; check diagnostics above.") + "\n");
      process.exitCode = exitCode;
      // All practical cleanup has been observed or explicitly reported failed.
      // On timeout, disconnect gives any surviving launcher its orphan fallback.
      for (const entry of children) {
        if (entry.process.connected) entry.process.disconnect();
        entry.process.stdout.destroy();
        entry.process.stderr.destroy();
        entry.process.unref();
      }
    });
    return shutdownPromise;
  }
  process.on("SIGINT", () => { void shutdown("SIGINT received", 0); });
  process.on("SIGTERM", () => { void shutdown("SIGTERM received", 0); });
  process.on("uncaughtException", (error) => { void shutdown("Supervisor error: " + error.message, 1); });
  process.on("unhandledRejection", (error) => { void shutdown("Supervisor rejection: " + String(error), 1); });
  for (const app of apps) {
    if (requested) break;
    let child;
    try { child = spawn(process.execPath, [script, "--app", app], {
      cwd: repository, detached: true, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }); } catch (error) { await shutdown(app + " launch failed: " + error.message, 1); break; }
    const entry = { app, process: child, closed: new Promise((resolve) => child.once("close", resolve)) };
    children.push(entry);
    prefixOutput(child.stdout, process.stdout, app);
    prefixOutput(child.stderr, process.stderr, app);
    child.on("message", (message) => {
      if (message.event === "started") process.stdout.write("[supervisor] " + app + " tree PID " + child.pid + ", pnpm PID " + message.pid + "\n");
      else if (!requested) void shutdown(app + " " + (message.detail ?? "exited (" + (message.code ?? message.signal) + ")"), 1);
    });
    child.once("error", (error) => { void shutdown(app + " launcher error: " + error.message, 1); });
    child.once("exit", (code, signal) => { if (!requested) void shutdown(app + " launcher exited (" + (code ?? signal) + ")", 1); });
  }
}

if (process.argv[2] === "--app") {
  await launcher(process.argv[3]);
} else {
  await supervise().catch((error) => {
    process.stderr.write("[supervisor] " + error.message + "\n");
    process.exitCode = 1;
  });
}
