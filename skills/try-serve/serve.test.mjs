import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./scripts/try-serve.mjs", import.meta.url));

function run(args, env = process.env) {
  return new Promise((done, fail) => {
    const child = spawn(script, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function waitUntil(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Timed out waiting for preview to stop");
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "try-serve-test-"));
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  const html = join(dir, "page.html");
  await writeFile(html, "<h1>preview</h1>");
  await writeFile(join(dir, "secret.txt"), "private");
  await writeFile(join(bin, "cloudflared"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(process.env.ORIGIN_FILE, process.argv[process.argv.indexOf('--url') + 1]);\nconsole.error(JSON.stringify({message:'https://preview-example.trycloudflare.com'}));\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  return { dir, html, state, originFile: join(dir, "origin"), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRY_SERVE_STATE_DIR: state, ORIGIN_FILE: join(dir, "origin") } };
}

test("create, inspect and kill a named background preview", async () => {
  const f = await fixture();
  let id;
  try {
    const startedAt = Date.now();
    const created = await run(["create", f.html], f.env);
    assert.equal(created.code, 0, created.stderr);
    const preview = JSON.parse(created.stdout);
    id = preview.id;
    assert.match(id, /^try-[a-z]{5}$/);
    assert.equal(preview.session, id);
    assert.equal(preview.status, "running");
    assert.equal(preview.url, "https://preview-example.trycloudflare.com");
    assert.ok(Date.parse(preview.expiresAt) >= startedAt + 30 * 60000);
    assert.ok(Date.parse(preview.expiresAt) <= Date.now() + 30 * 60000);
    const origin = await readFile(f.originFile, "utf8");
    assert.equal(await (await fetch(origin)).text(), "<h1>preview</h1>");
    assert.equal((await fetch(`${origin}/secret.txt`)).status, 404);
    assert.equal((await fetch(origin, { method: "POST" })).status, 405);
    assert.equal(JSON.parse((await run(["inspect", id], f.env)).stdout).url, preview.url);
    assert.equal(JSON.parse((await run(["inspect"], f.env)).stdout)[0].id, id);
    const killed = await run(["kill", id], f.env);
    assert.equal(killed.code, 0, killed.stderr);
    assert.equal(JSON.parse(killed.stdout).status, "stopped");
    await assert.rejects(fetch(origin));
    assert.deepEqual(JSON.parse((await run(["inspect"], f.env)).stdout), []);
  } finally {
    if (id) await run(["kill", id], f.env).catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("--expire stops the preview and removes its session state", async () => {
  const f = await fixture();
  let id;
  try {
    const created = await run(["create", f.html, "--expire", "2s"], f.env);
    assert.equal(created.code, 0, created.stderr);
    id = JSON.parse(created.stdout).id;
    await waitUntil(async () => JSON.parse((await run(["inspect"], f.env)).stdout).length === 0);
    assert.equal(JSON.parse((await run(["inspect", id], f.env)).stdout).status, "stale");
  } finally {
    if (id) await run(["kill", id], f.env).catch(() => {});
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("rejects symbolic links, invalid expiry, and invalid IDs", async () => {
  const f = await fixture();
  try {
    const invalid = await run(["create", f.html, "--expire", "0m"], f.env);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /positive duration/);
    assert.equal((await run(["kill", "other-session"], f.env)).code, 1);
    await symlink(f.html, join(f.dir, "link.html"));
    const linked = await run(["create", f.dir], f.env);
    assert.equal(linked.code, 1);
    assert.match(linked.stderr, /symbolic link/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
