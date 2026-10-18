import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_TASK_LENGTH = 80;
const KITTY_COMMAND_TIMEOUT_MS = 500;

export type SessionEnvState = "idle" | "running" | "waiting" | "done";
export type SessionEnvResult = "ok" | "error" | "blocked" | "cancelled";

type CommandResult = { status: number | null; stdout?: string; stderr?: string; error?: Error };

type RuntimeDeps = {
  env?: NodeJS.ProcessEnv;
  nowSeconds?: () => number;
  runCommand?: (command: string, args: string[]) => CommandResult;
};

type SessionEnvValues = Record<string, string>;

type MutableSessionEnv = {
  AGENT: string;
  AGENT_STATE: SessionEnvState;
  AGENT_RESULT: SessionEnvResult;
  AGENT_MODEL: string;
  AGENT_PROVIDER: string;
  AGENT_SESSION: string;
  AGENT_SESSION_NAME: string;
  AGENT_TASK: string;
  AGENT_CONTEXT: string;
  AGENT_COST: string;
  AGENT_UPDATED_AT: string;
};

const defaultDeps: Required<RuntimeDeps> = {
  env: process.env,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  runCommand(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: KITTY_COMMAND_TIMEOUT_MS });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error };
  },
};

function commandMissing(result: Pick<CommandResult, "error">): boolean {
  return (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function remoteControlTarget(env: NodeJS.ProcessEnv): string | undefined {
  return env.PI_TERMINAL_KITTY_TO || env.PI_PANE_KITTY_TO || env.KITTY_LISTEN_ON;
}

function kittyRemoteArgs(env: NodeJS.ProcessEnv, args: string[]): string[] {
  const to = remoteControlTarget(env);
  return ["@", ...(to ? ["--to", to] : []), ...args];
}

function runKittyCommand(deps: Required<RuntimeDeps>, args: string[]): CommandResult {
  const kitten = deps.runCommand("kitten", args);
  if (kitten.status === 0 || !commandMissing(kitten)) return kitten;
  return deps.runCommand("kitty", args);
}

export function writeKittyUserVars(values: SessionEnvValues, deps: RuntimeDeps = {}): CommandResult | undefined {
  const merged = { ...defaultDeps, ...deps };
  const env = merged.env ?? process.env;
  if (!env.TERM?.includes("kitty") && !env.KITTY_WINDOW_ID && !env.KITTY_LISTEN_ON && !env.PI_TERMINAL_KITTY_TO && !env.PI_PANE_KITTY_TO) {
    return undefined;
  }

  const assignments = Object.entries(values).map(([key, value]) => `${key}=${value.replace(/\0/g, "")}`);
  if (assignments.length === 0) return undefined;
  try {
    return runKittyCommand(merged, kittyRemoteArgs(env, ["set-user-vars", ...assignments]));
  } catch (error) {
    return { status: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function truncateTask(value: string): string {
  const compact = value.replace(/\0/g, "").replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= MAX_TASK_LENGTH) return compact;
  return `${characters.slice(0, MAX_TASK_LENGTH - 1).join("")}…`;
}

function textFromPrompt(event: unknown): string {
  const prompt = (event as { prompt?: unknown })?.prompt;
  return typeof prompt === "string" ? truncateTask(prompt) : "";
}

function readSession(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId?.() || ctx.sessionManager.getSessionFile?.() || "";
  } catch {
    return "";
  }
}

function readSessionName(pi: ExtensionAPI, ctx: ExtensionContext): string {
  try {
    return pi.getSessionName?.() || ctx.getSessionName?.() || "";
  } catch {
    return "";
  }
}

function readModel(ctx: ExtensionContext): { model: string; provider: string } {
  const model = ctx.model as { id?: unknown; name?: unknown; provider?: unknown } | undefined;
  return {
    model: typeof model?.name === "string" ? model.name : typeof model?.id === "string" ? model.id : "",
    provider: typeof model?.provider === "string" ? model.provider : "",
  };
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
}

function formatContextUsage(ctx: ExtensionContext): string {
  try {
    const usage = ctx.getContextUsage?.() as { tokens?: unknown; maxTokens?: unknown; contextWindow?: unknown; percent?: unknown } | undefined;
    if (!usage) return "";
    const tokens = typeof usage.tokens === "number" ? usage.tokens : undefined;
    const maxTokens = typeof usage.maxTokens === "number" ? usage.maxTokens : typeof usage.contextWindow === "number" ? usage.contextWindow : undefined;
    const percent = typeof usage.percent === "number" ? Math.round(usage.percent) : tokens != null && maxTokens ? Math.round((tokens / maxTokens) * 100) : undefined;

    if (percent != null && tokens != null && maxTokens != null) return `${percent}% ${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)}`;
    if (percent != null) return `${percent}%`;
    if (tokens != null && maxTokens != null) return `${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)}`;
    if (tokens != null) return `${formatTokenCount(tokens)} tokens`;
    return "";
  } catch {
    return "";
  }
}

function lastAssistantMessage(messages: unknown): { role?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { cost?: { total?: unknown }; input?: unknown; output?: unknown } } | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: { cost?: { total?: unknown }; input?: unknown; output?: unknown } };
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function formatCostFromMessages(messages: unknown): string {
  const message = lastAssistantMessage(messages);
  if (!message) return "";
  const cost = message.usage?.cost?.total;
  if (typeof cost === "number" && Number.isFinite(cost)) return `$${cost.toFixed(cost < 1 ? 4 : 2)}`;
  const input = typeof message.usage?.input === "number" ? message.usage.input : 0;
  const output = typeof message.usage?.output === "number" ? message.usage.output : 0;
  if (input > 0 || output > 0) return `${formatTokenCount(input + output)} tokens`;
  return "";
}

function errorMessageFromEvent(event: unknown): string | undefined {
  const assistant = lastAssistantMessage((event as { messages?: unknown })?.messages);
  if (assistant?.stopReason !== "error") return undefined;
  const message = String(assistant.errorMessage ?? "").trim();
  return message ? truncateTask(message) : "agent error";
}

function resultFromEvent(event: unknown): SessionEnvResult {
  const reason = String(lastAssistantMessage((event as { messages?: unknown })?.messages)?.stopReason ?? "").toLowerCase();
  if (reason === "blocked") return "blocked";
  if (reason === "aborted" || reason === "cancelled" || reason === "canceled") return "cancelled";
  if (reason === "error" || reason === "timeout") return "error";
  return "ok";
}

export function registerSessionEnv(pi: ExtensionAPI, deps: RuntimeDeps = {}): void {
  const merged = { ...defaultDeps, ...deps };
  let pendingEndPatch: Partial<MutableSessionEnv> | undefined;
  const state: MutableSessionEnv = {
    AGENT: "pi",
    AGENT_STATE: "idle",
    AGENT_RESULT: "ok",
    AGENT_MODEL: "",
    AGENT_PROVIDER: "",
    AGENT_SESSION: "",
    AGENT_SESSION_NAME: "",
    AGENT_TASK: "",
    AGENT_CONTEXT: "",
    AGENT_COST: "",
    AGENT_UPDATED_AT: "",
  };

  function publish(ctx: ExtensionContext | undefined, patch: Partial<MutableSessionEnv> = {}): void {
    if (ctx) {
      const model = readModel(ctx);
      state.AGENT_MODEL = model.model;
      state.AGENT_PROVIDER = model.provider;
      state.AGENT_SESSION = readSession(ctx);
      state.AGENT_SESSION_NAME = readSessionName(pi, ctx);
      state.AGENT_CONTEXT = formatContextUsage(ctx);
    }

    Object.assign(state, patch);
    state.AGENT_UPDATED_AT = String(merged.nowSeconds());
    writeKittyUserVars(state, merged);
  }

  pi.on("session_start", async (_event, ctx) => {
    publish(ctx, { AGENT_STATE: "idle" });
  });

  pi.on("model_select", async (_event, ctx) => {
    publish(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    pendingEndPatch = undefined;
    publish(ctx, { AGENT_STATE: "running", AGENT_RESULT: "ok", AGENT_TASK: textFromPrompt(event) });
  });

  pi.on("agent_start", async (_event, ctx) => {
    pendingEndPatch = undefined;
    publish(ctx, { AGENT_STATE: "running" });
  });

  pi.on("agent_end", async (event) => {
    const errorMessage = errorMessageFromEvent(event);
    pendingEndPatch = {
      AGENT_RESULT: resultFromEvent(event),
      AGENT_TASK: errorMessage ? errorMessage : state.AGENT_TASK,
      AGENT_COST: formatCostFromMessages((event as { messages?: unknown })?.messages),
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    publish(ctx, { AGENT_STATE: "idle", ...pendingEndPatch });
    pendingEndPatch = undefined;
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pendingEndPatch = undefined;
    publish(ctx, { AGENT_STATE: "done" });
  });
}

export default function sessionEnv(pi: ExtensionAPI): void {
  registerSessionEnv(pi);
}

export const __test = {
  KITTY_COMMAND_TIMEOUT_MS,
  MAX_TASK_LENGTH,
  errorMessageFromEvent,
  formatContextUsage,
  formatCostFromMessages,
  textFromPrompt,
  writeKittyUserVars,
};
