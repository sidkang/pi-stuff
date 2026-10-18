type BlockKind =
  | "pip"
  | "pip3"
  | "poetry"
  | "python-pip"
  | "python-venv"
  | "python-py-compile"
  | "python-ast-multiple-files";

interface BlockedCommand {
  kind: BlockKind;
  message: string;
}

const AST_OPTIONS_WITH_VALUE = new Set(["-m", "--mode", "-i", "--indent", "--feature-version", "-O"]);
const UV_RUN_OPTIONS_WITH_VALUE = new Set([
  "--allow-insecure-host",
  "--cache-dir",
  "--color",
  "--config-file",
  "--config-setting",
  "--config-settings-package",
  "--default-index",
  "--directory",
  "--env-file",
  "--exclude-newer",
  "--exclude-newer-package",
  "--extra",
  "--extra-index-url",
  "--find-links",
  "--fork-strategy",
  "--group",
  "--index",
  "--index-strategy",
  "--index-url",
  "--keyring-provider",
  "--link-mode",
  "--no-binary-package",
  "--no-build-isolation-package",
  "--no-build-package",
  "--no-editable-package",
  "--no-extra",
  "--no-group",
  "--no-sources-package",
  "--only-group",
  "--package",
  "--prerelease",
  "--project",
  "--python",
  "--python-platform",
  "--refresh-package",
  "--reinstall-package",
  "--resolution",
  "--upgrade-group",
  "--upgrade-package",
  "--with",
  "--with-editable",
  "--with-requirements",
]);
const UV_RUN_SHORT_OPTIONS_WITH_VALUE = new Set(["-C", "-f", "-i", "-P", "-p", "-w"]);
const PYTHON_OPTIONS_WITH_VALUE = new Set(["--check-hash-based-pycs", "-W", "-X"]);

function basename(command: string): string {
  return command.replace(/\\+/g, "/").split("/").pop() ?? command;
}

function isPythonCommand(command: string): boolean {
  return /^python(?:3(?:\.\d+)?)?$/.test(basename(command));
}

function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);

    const match = /(^|[^<])<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2/.exec(line);
    if (!match) continue;

    const delimiter = match[3];
    i += 1;
    while (i < lines.length && lines[i].trim() !== delimiter) i += 1;
    if (i < lines.length) kept.push(lines[i]);
  }

  return kept.join("\n");
}

function removeEscapedNewlines(command: string): string {
  return command.replace(/\\\r?\n/g, "");
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = () => {
    const segment = current.trim();
    if (segment) segments.push(segment);
    current = "";
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      current += ch;
      if (quote !== "'") escaped = true;
      continue;
    }

    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }

    if (ch === "\n" || ch === ";" || ch === "|") {
      flush();
      if (ch === "|" && next === "|") i += 1;
      continue;
    }

    if (ch === "&" && next === "&") {
      flush();
      i += 1;
      continue;
    }

    current += ch;
  }

  flush();
  return segments;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
  }

  push();
  return tokens;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandIndex(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i])) i += 1;

  if (tokens[i] === "command") i += 1;

  if (tokens[i] === "env") {
    i += 1;
    while (i < tokens.length) {
      const token = tokens[i];
      if (isEnvAssignment(token)) {
        i += 1;
        continue;
      }
      if (token === "-u" || token === "--unset" || /^-[A-Za-z]*u[A-Za-z]*$/.test(token)) {
        i += 2;
        continue;
      }
      if (token.startsWith("--unset=")) {
        i += 1;
        continue;
      }
      if (token.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
  }

  return i;
}

function messageFor(kind: BlockKind): string {
  if (kind === "pip" || kind === "pip3") {
    return [
      `Error: ${kind} is disabled. Use uv instead:`,
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (kind === "poetry") {
    return [
      "Error: poetry is disabled. Use uv instead:",
      "",
      "  To initialize a project: uv init",
      "  To add a dependency: uv add PACKAGE",
      "  To sync dependencies: uv sync",
      "  To run commands: uv run COMMAND",
      "",
    ].join("\n");
  }

  if (kind === "python-pip") {
    return [
      "Error: 'python -m pip' is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (kind === "python-venv") {
    return [
      "Error: 'python -m venv' is disabled. Use the centralized mise-managed venv setup instead:",
      "",
      "  To initialize a project venv: mise py:init [VENV_NAME]",
      "  To recreate it: mise py:reset [VENV_NAME]",
      "",
      "This writes project env settings to mise.toml and stores the venv under CENTRAL_VENV_DIR.",
      "",
    ].join("\n");
  }

  if (kind === "python-py-compile") {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }

  return [
    "Error: 'python -m ast' accepts one input file at a time.",
    "",
    "  For multiple files, loop explicitly:",
    "  for f in file1.py file2.py; do uv run python -m ast \"$f\" >/dev/null || exit 1; done",
    "",
  ].join("\n");
}

function blocked(kind: BlockKind): BlockedCommand {
  return { kind, message: messageFor(kind) };
}

function pythonModule(tokens: string[], pythonIndex: number): { moduleName: string; moduleIndex: number } | null {
  for (let i = pythonIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-c" || token === "-") return null;
    if (token === "-m") {
      const moduleName = tokens[i + 1];
      return moduleName ? { moduleName, moduleIndex: i + 1 } : null;
    }
    if (token.startsWith("-m") && token.length > 2) {
      return { moduleName: token.slice(2), moduleIndex: i };
    }
    if (PYTHON_OPTIONS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.includes("=") && token.startsWith("--check-hash-based-pycs=")) continue;
    if ((token.startsWith("-W") || token.startsWith("-X")) && token.length > 2) continue;
    if (!token.startsWith("-")) return null;
  }
  return null;
}

function isRedirectionToken(token: string): boolean {
  return /^(?:\d*)[<>]/.test(token) || token === "|" || token === "2>&1" || token === "&>" || token === "&>>";
}

function redirectionConsumesNextToken(token: string): boolean {
  return /^(?:\d*)(?:<|>|<>|<<|>>|<<<)$/.test(token) || token === "&>" || token === "&>>";
}

function astPositionalCount(tokens: string[], moduleIndex: number): number {
  let count = 0;
  for (let i = moduleIndex + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (redirectionConsumesNextToken(token)) {
      i += 1;
      continue;
    }
    if (isRedirectionToken(token)) continue;
    if (AST_OPTIONS_WITH_VALUE.has(token)) {
      i += 1;
      continue;
    }
    if (token.includes("=") && (token.startsWith("--mode=") || token.startsWith("--indent=") || token.startsWith("--feature-version="))) {
      continue;
    }
    if (token.startsWith("-")) continue;
    count += 1;
  }
  return count;
}

function checkPythonInvocation(tokens: string[], pythonIndex: number): BlockedCommand | null {
  const mod = pythonModule(tokens, pythonIndex);
  if (!mod) return null;

  if (mod.moduleName === "pip") return blocked("python-pip");
  if (mod.moduleName === "venv") return blocked("python-venv");
  if (mod.moduleName === "py_compile") return blocked("python-py-compile");
  if (mod.moduleName === "ast" && astPositionalCount(tokens, mod.moduleIndex) > 1) {
    return blocked("python-ast-multiple-files");
  }

  return null;
}

function uvRunCommandIndex(tokens: string[], uvIndex: number): number | null {
  if (tokens[uvIndex + 1] !== "run") return null;

  let i = uvIndex + 2;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") return i + 1 < tokens.length ? i + 1 : null;
    if (!token.startsWith("-")) return i;
    if (token.includes("=")) {
      i += 1;
      continue;
    }
    if (UV_RUN_OPTIONS_WITH_VALUE.has(token) || UV_RUN_SHORT_OPTIONS_WITH_VALUE.has(token)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return null;
}

function checkSegment(segment: string): BlockedCommand | null {
  const tokens = tokenize(segment);
  const index = commandIndex(tokens);
  const command = tokens[index];
  if (!command) return null;

  const name = basename(command);
  if (name === "pip") return blocked("pip");
  if (name === "pip3") return blocked("pip3");
  if (name === "poetry") return blocked("poetry");

  if (isPythonCommand(command)) {
    return checkPythonInvocation(tokens, index);
  }

  if (name === "uv") {
    const nestedIndex = uvRunCommandIndex(tokens, index);
    const nestedCommand = nestedIndex === null ? "" : (tokens[nestedIndex] ?? "");
    const nestedName = basename(nestedCommand);
    if (nestedName === "pip") return blocked("pip");
    if (nestedName === "pip3") return blocked("pip3");
    if (nestedName === "poetry") return blocked("poetry");
    if (nestedIndex !== null && isPythonCommand(nestedCommand)) {
      return checkPythonInvocation(tokens, nestedIndex);
    }
  }

  return null;
}

export function getBlockedCommand(command: string): BlockedCommand | null {
  const commandWithoutHeredocBodies = removeEscapedNewlines(stripHeredocBodies(command));
  for (const segment of splitShellSegments(commandWithoutHeredocBodies)) {
    const blockedCommand = checkSegment(segment);
    if (blockedCommand) return blockedCommand;
  }
  return null;
}

export function getBlockedCommandMessage(command: string): string | null {
  return getBlockedCommand(command)?.message ?? null;
}

export const __test = {
  astPositionalCount,
  checkSegment,
  commandIndex,
  getBlockedCommand,
  removeEscapedNewlines,
  splitShellSegments,
  stripHeredocBodies,
  tokenize,
  uvRunCommandIndex,
};
