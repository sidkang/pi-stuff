#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createControlServer } from "node:net";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = process.env.TRY_SERVE_STATE_DIR || join(homedir(), ".cache", "try-serve");
const idPattern = /^try-[a-z]{5}$/;
const types = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".txt": "text/plain", ".pdf": "application/pdf",
};

function statePath(id) {
  if (!idPattern.test(id)) throw new Error("Invalid preview ID");
  return join(root, id);
}

async function checkTree(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`Unsupported entry (or symbolic link): ${path}`);
  }
  if (stat.isDirectory()) {
    for (const entry of await readdir(path)) await checkTree(join(path, entry));
  }
  return stat;
}

async function checkSource(source) {
  const stat = await checkTree(source);
  if (stat.isFile() && !/\.html?$/i.test(source)) throw new Error("Expected an HTML file or static directory");
  if (stat.isDirectory() && !(await lstat(join(source, "index.html")).catch(() => null))?.isFile()) {
    throw new Error("Static directory must contain index.html");
  }
  return stat;
}

function staticServer(source, stat) {
  return createHttpServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const name = pathname === "/" ? "/index.html" : pathname;
      const file = stat.isFile() ? (name === "/index.html" ? source : null) : resolve(source, `.${name}`);
      const subpath = file && relative(source, file);
      if (!file || subpath === ".." || subpath.startsWith(`..${sep}`)) {
        response.writeHead(404).end();
        return;
      }
      const target = await lstat(file).catch(() => null);
      if (!target?.isFile() || target.isSymbolicLink()) {
        response.writeHead(404).end();
        return;
      }
      const type = types[extname(file).toLowerCase()] || "application/octet-stream";
      response.writeHead(200, {
        "Content-Type": `${type}${/^(text\/|application\/json)/.test(type) ? "; charset=utf-8" : ""}`,
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).on("error", () => response.destroy()).pipe(response);
    } catch {
      response.writeHead(400).end();
    }
  });
}

function parseExpire(value) {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match || Number(match[1]) < 1) throw new Error("Expiry must be a positive duration, e.g. 30m, 2h or 60s");
  const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000 }[match[2]];
  if (!Number.isSafeInteger(ms) || ms > 24 * 3600000) throw new Error("Expiry cannot exceed 24h");
  return ms;
}

async function listen(server, ...args) {
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(...args, ok);
  });
}

async function close(server) {
  if (server?.listening) await new Promise((done) => server.close(done));
}

async function writeJson(path, data) {
  await writeFile(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function worker(id, source, duration) {
  const state = statePath(id);
  const stat = await checkSource(source);
  const http = staticServer(source, stat);
  let control;
  let tunnel;
  let tunnelClosed;
  let ready;
  let stopping;
  const expiresAt = new Date(Date.now() + duration).toISOString();

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (tunnel && tunnel.exitCode === null) {
        tunnel.kill("SIGTERM");
        const forced = setTimeout(() => tunnel.kill("SIGKILL"), 5000);
        await tunnelClosed;
        clearTimeout(forced);
      }
      if (http.listening) http.closeAllConnections();
      await close(http);
      await close(control);
      if (ready) await rm(state, { recursive: true, force: true });
    })();
    return stopping;
  }

  process.on("SIGTERM", () => { void stop(); });
  process.on("SIGINT", () => { void stop(); });
  try {
    await listen(http, 0, "127.0.0.1");
    control = createControlServer((socket) => {
      socket.setTimeout(2000, () => socket.destroy());
      socket.once("data", (data) => {
        const action = data.toString().trim();
        if (action === "inspect") socket.end(JSON.stringify(ready || { id, status: "starting" }));
        else if (action === "kill") {
          socket.end(JSON.stringify({ id, status: "stopping" }));
          socket.once("close", () => { void stop(); });
        } else socket.end(JSON.stringify({ error: "Unknown action" }));
      });
    });
    await listen(control, join(state, "control.sock"));
    const home = join(state, "home");
    await mkdir(home);
    tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${http.address().port}`, "--output", "json", "--no-autoupdate"], {
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    tunnelClosed = new Promise((done) => {
      tunnel.once("close", done);
    });
    let recent = "";
    let launchError;
    tunnel.once("error", (error) => { launchError = error; });
    const consume = (chunk) => {
      recent = `${recent}${chunk.toString()}`.slice(-8192);
      if (ready) return;
      const match = recent.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
      if (match) {
        ready = { id, session: id, status: "running", url: match[0], expiresAt };
        clearTimeout(startupTimer);
        void writeJson(join(state, "ready"), ready).catch(() => { void stop(); });
      }
    };
    tunnel.stdout.on("data", consume);
    tunnel.stderr.on("data", consume);
    const startupTimer = setTimeout(() => { void stop(); }, 60000);
    const expiryTimer = setTimeout(() => { void stop(); }, duration);
    await tunnelClosed;
    clearTimeout(startupTimer);
    clearTimeout(expiryTimer);
    if (!ready) throw launchError || new Error(`Tunnel stopped before producing a URL: ${recent}`);
    await stop();
  } catch (error) {
    await writeJson(join(state, "error"), { error: String(error) }).catch(() => {});
    await stop();
  }
}

function request(id, action) {
  return new Promise((ok, fail) => {
    const socket = connect(join(statePath(id), "control.sock"));
    socket.setTimeout(2000, () => socket.destroy(new Error("Control request timed out")));
    let output = "";
    socket.on("connect", () => socket.end(action));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", fail);
    socket.on("end", () => {
      try { ok(JSON.parse(output)); } catch (error) { fail(error); }
    });
  });
}

async function inspect(id) {
  const state = statePath(id);
  const recorded = await readFile(join(state, "ready"), "utf8").then(JSON.parse).catch(() => ({ id }));
  try { return await request(id, "inspect"); }
  catch { return { ...recorded, id, status: "stale" }; }
}

async function create(source, duration) {
  await checkSource(source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error(`State directory must be private (0700): ${root}`);
  }
  let id;
  let state;
  for (let attempt = 0; attempt < 10; attempt++) {
    id = `try-${Array.from(randomBytes(5), (byte) => String.fromCharCode(97 + byte % 26)).join("")}`;
    state = statePath(id);
    try { await mkdir(state, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    state = null;
  }
  if (!state) throw new Error("Could not allocate a unique preview ID");
  const child = spawn("screen", ["-dmS", id, process.execPath, script, "--worker", id, source, String(duration)], { stdio: "ignore" });
  try {
    const code = await new Promise((ok, fail) => {
      child.once("error", fail);
      child.once("close", ok);
    });
    if (code !== 0) throw new Error(`screen failed with exit code ${code}`);
    const deadline = Date.now() + 62000;
    while (Date.now() < deadline) {
      const ready = await readFile(join(state, "ready"), "utf8").catch(() => null);
      if (ready) {
        const live = await request(id, "inspect").catch(() => null);
        if (!live || live.status !== "running") throw new Error("Preview stopped during startup");
        console.log(JSON.stringify(live));
        return;
      }
      const error = await readFile(join(state, "error"), "utf8").catch(() => null);
      if (error) throw new Error(JSON.parse(error).error);
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("Timed out waiting for a Quick Tunnel URL");
  } catch (error) {
    const stopped = await request(id, "kill").then(() => true).catch(() => false);
    if (!stopped) spawn("screen", ["-S", id, "-X", "quit"], { stdio: "ignore" }).unref();
    await rm(state, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--worker" && args.length === 3) {
    await worker(args[0], args[1], Number(args[2]));
  } else if (command === "create" && (args.length === 1 || (args.length === 3 && args[1] === "--expire"))) {
    await create(resolve(args[0]), parseExpire(args[2] || "30m"));
  } else if (command === "inspect" && args.length <= 1) {
    const ids = args.length ? args : await readdir(root).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const result = await Promise.all(ids.filter((id) => idPattern.test(id)).map(inspect));
    console.log(JSON.stringify(args.length ? result[0] : result));
  } else if (command === "kill" && args.length === 1) {
    const result = await request(args[0], "kill");
    if (result.status !== "stopping") throw new Error(JSON.stringify(result));
    const state = statePath(args[0]);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (!(await lstat(state).catch(() => null))) {
        console.log(JSON.stringify({ id: args[0], status: "stopped" }));
        return;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`Preview did not stop: ${args[0]}`);
  } else {
    throw new Error("Usage: ./scripts/try-serve.mjs create <html-or-static-directory> [--expire 30m] | inspect [id] | kill <id>");
  }
}

main().catch((error) => {
  console.error(`try-serve: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
