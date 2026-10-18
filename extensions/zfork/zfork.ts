import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_HEIGHT_PERCENT = 40;
const DEFAULT_MIN_HEIGHT_LINES = 12;
const DEFAULT_MAX_HEIGHT_LINES = 32;
const MAX_ERROR_CHARACTERS = 500;
const EXEC_MAX_BUFFER = 64 * 1024;

type KittyWindowInfo = {
  id?: number;
  is_self?: boolean;
  lines?: number;
};

type KittyTabInfo = {
  id?: number;
  windows?: KittyWindowInfo[];
};

type KittyOsWindowInfo = {
  tabs?: KittyTabInfo[];
};

type HeightSettings = {
  minLines: number;
  maxLines: number;
  percent: number;
};

type CurrentKittyWindow = {
  tabId: number;
  window: KittyWindowInfo;
};

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function resolveCommand(command: string): string | null {
  if (!/^[a-zA-Z0-9._+-]+$/.test(command)) return null;
  try {
    return execFileSync("sh", ["-c", `command -v -- ${command}`], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: EXEC_MAX_BUFFER,
    }).trim() || null;
  } catch {
    return null;
  }
}

function getKittyCommand(): string | null {
  return resolveCommand("kitten") ?? resolveCommand("kitty");
}

function getPiCommand(): string | null {
  return resolveCommand("pi");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Math.floor(readNumberEnv(name, fallback));
  return value > 0 ? value : fallback;
}

function getHeightSettings(): HeightSettings {
  const minLines = readPositiveIntegerEnv("PI_ZFORK_HEIGHT_MIN_LINES", DEFAULT_MIN_HEIGHT_LINES);
  const maxLines = Math.max(
    minLines,
    readPositiveIntegerEnv("PI_ZFORK_HEIGHT_MAX_LINES", DEFAULT_MAX_HEIGHT_LINES),
  );
  const percent = clamp(readNumberEnv("PI_ZFORK_HEIGHT_PERCENT", DEFAULT_HEIGHT_PERCENT), 1, 99);

  return { minLines, maxLines, percent };
}

function findSelfWindow(tree: unknown): CurrentKittyWindow | null {
  if (!Array.isArray(tree)) return null;

  const currentWindowId = Number(process.env.KITTY_WINDOW_ID);
  for (const osWindow of tree as KittyOsWindowInfo[]) {
    const tabs = Array.isArray(osWindow.tabs) ? osWindow.tabs : [];
    for (const tab of tabs) {
      if (!Number.isSafeInteger(tab.id) || (tab.id as number) < 1) continue;
      const windows = Array.isArray(tab.windows) ? tab.windows : [];
      for (const window of windows) {
        if (window.is_self) return { tabId: tab.id as number, window };
        if (Number.isFinite(currentWindowId) && window.id === currentWindowId) {
          return { tabId: tab.id as number, window };
        }
      }
    }
  }

  return null;
}

function getCurrentKittyWindow(kittyCommand: string): CurrentKittyWindow | null {
  try {
    const output = execFileSync(kittyCommand, ["@", "ls", "--self"], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return findSelfWindow(JSON.parse(output));
  } catch {
    return null;
  }
}

function getKittyHeightPercent(currentLines: number | null): number {
  const settings = getHeightSettings();
  if (!currentLines) return Math.round(settings.percent);

  const preferredLines = Math.round((currentLines * settings.percent) / 100);
  const targetLines = Math.min(
    Math.max(preferredLines, settings.minLines),
    settings.maxLines,
    Math.max(1, currentLines - 1),
  );

  return clamp(Math.round((targetLines / currentLines) * 100), 1, 99);
}

function normalizeInitialPrompt(initialPrompt?: string): string | null {
  const prompt = initialPrompt?.trim();
  if (!prompt) return null;
  return prompt.startsWith("-") || prompt.startsWith("@") ? ` ${prompt}` : prompt;
}

function buildZforkScript(
  piCommand: string,
  sessionFile: string,
  sessionsRoot: string,
  initialPrompt?: string,
): string {
  const commandParts = [
    shellEscape(piCommand),
    "--session-dir",
    '"$session_dir"',
    "--fork",
    shellEscape(sessionFile),
  ];
  const prompt = normalizeInitialPrompt(initialPrompt);
  if (prompt) commandParts.push(shellEscape(prompt));

  const command = commandParts.join(" ");
  const environment = buildForwardedEnvironmentLines();

  return [
    ...environment,
    `session_dir=$(mktemp -d ${shellEscape(join(sessionsRoot, "session.XXXXXXXX"))})`,
    'if [ -z "$session_dir" ]; then echo "[zfork] failed to create temporary session dir" >&2; exit 1; fi',
    'printf "[zfork] temporary session dir: %s\\n" "$session_dir"',
    command,
    "status=$?",
    'exit "$status"',
  ].join("\n");
}

function writeZforkScript(command: string | ((root: string) => string)): { root: string; scriptPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-zfork-"));
  chmodSync(root, 0o700);
  const scriptPath = join(root, `cmd-${randomUUID()}.sh`);
  const content = typeof command === "function" ? command(root) : command;
  writeFileSync(scriptPath, `#!/usr/bin/env bash\n${content}\n`, {
    flag: "wx",
    mode: 0o700,
  });
  return { root, scriptPath };
}

function shouldForwardEnvironment(name: string): boolean {
  return name === "PATH"
    || name === "GH_TOKEN"
    || name === "GITHUB_TOKEN"
    || name === "AWS_ACCESS_KEY_ID"
    || name === "AWS_SECRET_ACCESS_KEY"
    || name === "AWS_SESSION_TOKEN"
    || name === "AWS_REGION"
    || name === "AWS_PROFILE"
    || name === "HTTP_PROXY"
    || name === "HTTPS_PROXY"
    || name === "NO_PROXY"
    || name === "ALL_PROXY"
    || name === "PI_CODING_AGENT_DIR"
    || name === "PI_PACKAGE_DIR"
    || name === "PI_OFFLINE"
    || name === "PI_SKIP_VERSION_CHECK"
    || name === "PI_TELEMETRY"
    || name === "PI_CACHE_RETENTION"
    || name === "PI_SHARE_VIEWER_URL"
    || /_(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN)$/.test(name);
}

function buildForwardedEnvironmentLines(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && shouldForwardEnvironment(name))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `export ${name}=${shellEscape(value as string)}`);
}

function buildKittyLaunchArgs(
  tabId: number,
  currentWindowId: string,
  cwd: string,
  scriptPath: string,
  heightPercent: number,
): string[] {
  const tabMatch = `id:${tabId}`;
  const windowMatch = `id:${currentWindowId}`;
  return [
    "@",
    "launch",
    "--match",
    tabMatch,
    "--type",
    "window",
    "--location",
    "hsplit",
    "--next-to",
    windowMatch,
    "--source-window",
    windowMatch,
    "--copy-env",
    "--title",
    "zfork",
    "--cwd",
    cwd,
    "--bias",
    String(heightPercent),
    "/bin/bash",
    scriptPath,
  ];
}

function launchKittyPane(
  kittyCommand: string,
  cwd: string,
  scriptPath: string,
): { heightPercent: number; windowId: string } {
  const currentWindowId = process.env.KITTY_WINDOW_ID;
  if (!currentWindowId || !/^\d+$/.test(currentWindowId)) {
    throw new Error("zfork requires a Kitty window (KITTY_WINDOW_ID is missing)");
  }

  const current = getCurrentKittyWindow(kittyCommand);
  if (!current) throw new Error("zfork could not identify the current Kitty tab");
  const tabMatch = `id:${current.tabId}`;
  const currentLines = typeof current.window.lines === "number" && current.window.lines > 0
    ? current.window.lines
    : null;
  const heightPercent = getKittyHeightPercent(currentLines);

  execFileSync(kittyCommand, ["@", "goto-layout", "--match", tabMatch, "splits"], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: EXEC_MAX_BUFFER,
  });
  const windowId = execFileSync(
    kittyCommand,
    buildKittyLaunchArgs(current.tabId, currentWindowId, cwd, scriptPath, heightPercent),
    { encoding: "utf8", timeout: 5000, maxBuffer: EXEC_MAX_BUFFER },
  ).trim();

  if (!/^\d+$/.test(windowId)) {
    throw new Error(`Unexpected Kitty window id: ${windowId || "(empty)"}`);
  }

  return { heightPercent, windowId };
}

function sanitizeErrorText(text: string): string {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, MAX_ERROR_CHARACTERS).join("");
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : stderr;
    if (typeof text === "string" && text.trim()) return sanitizeErrorText(text);
  }

  return sanitizeErrorText(error instanceof Error ? error.message : String(error));
}

function isSshSession(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY);
}

async function runZfork(ctx: ExtensionContext, initialPrompt?: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("zfork requires interactive mode", "error");
    return;
  }

  if (isSshSession()) {
    ctx.ui.notify("zfork currently supports local Kitty panes only", "error");
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify("zfork requires a saved session; --no-session cannot be forked", "error");
    return;
  }

  const kittyCommand = getKittyCommand();
  if (!kittyCommand || !process.env.KITTY_WINDOW_ID) {
    ctx.ui.notify("zfork requires Kitty remote control", "error");
    return;
  }

  const piCommand = getPiCommand();
  if (!piCommand) {
    ctx.ui.notify("zfork could not find the Pi executable", "error");
    return;
  }

  try {
    const { scriptPath } = writeZforkScript((root) =>
      buildZforkScript(piCommand, sessionFile, root, initialPrompt),
    );
    const { heightPercent, windowId } = launchKittyPane(kittyCommand, ctx.cwd, scriptPath);
    const suffix = windowId ? ` (${windowId})` : "";
    ctx.ui.notify(`Opened temporary fork below current Kitty pane${suffix}, height ${heightPercent}%`, "info");
  } catch (error) {
    ctx.ui.notify(`zfork failed: ${describeError(error)}`, "error");
  }
}

export const __test = {
  buildForwardedEnvironmentLines,
  buildKittyLaunchArgs,
  buildZforkScript,
  describeError,
  findSelfWindow,
  getHeightSettings,
  getKittyHeightPercent,
  normalizeInitialPrompt,
  shellEscape,
  writeZforkScript,
};

export default function zforkExtension(pi: ExtensionAPI): void {
  pi.registerCommand("zfork", {
    description: "Open a temporary fork of the current Pi session below the current Kitty pane",
    handler: async (args, ctx) => {
      await runZfork(ctx, typeof args === "string" ? args : undefined);
    },
  });
}
