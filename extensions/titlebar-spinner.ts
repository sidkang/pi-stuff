/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   pi --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function sanitizeTitlePart(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function getTitle(pi: ExtensionAPI, frame: string): string {
	const cwd = sanitizeTitlePart(path.basename(process.cwd()));
	const session = sanitizeTitlePart(pi.getSessionName() ?? "");
	return session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
}

export default function titlebarSpinner(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let settleTimer: ReturnType<typeof setTimeout> | null = null;
	let frameIndex = 0;
	let agentRunning = false;
	let currentCtx: ExtensionContext | null = null;
	const activeSubagents = new Set<string>();

	function showNextFrame(ctx: ExtensionContext): void {
		const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
		ctx.ui.setTitle(getTitle(pi, frame));
		frameIndex++;
	}

	function stopAnimation(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function startAnimation(ctx: ExtensionContext): void {
		if (timer) return;
		showNextFrame(ctx);
		timer = setInterval(() => showNextFrame(ctx), 80);
	}

	function maybeStopAnimation(ctx: ExtensionContext): void {
		if (!agentRunning && activeSubagents.size === 0 && ctx.isIdle()) {
			stopAnimation();
		}
	}

	function getEventId(data: unknown, key: "id" | "runId"): string | null {
		if (!data || typeof data !== "object") return null;
		const id = (data as Record<string, unknown>)[key];
		return typeof id === "string" && id.length > 0 ? id : null;
	}

	function scheduleSettleCheck(): void {
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = null;
			if (currentCtx?.mode === "tui") maybeStopAnimation(currentCtx);
		}, 0);
	}

	function startForCurrentTui(): void {
		if (currentCtx?.mode === "tui") startAnimation(currentCtx);
	}

	const unsubscribeStarted = pi.events.on("subagent:async-started", (data: unknown) => {
		const id = getEventId(data, "id");
		if (!id) return;
		activeSubagents.add(id);
		startForCurrentTui();
	});

	const unsubscribeCompleted = pi.events.on("subagent:async-complete", (data: unknown) => {
		const id = getEventId(data, "runId");
		if (id) activeSubagents.delete(id);
		scheduleSettleCheck();
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		if (ctx.mode !== "tui") return;
		showNextFrame(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentRunning = true;
		if (ctx.mode !== "tui") return;
		startAnimation(ctx);
	});

	pi.on("agent_end", async () => {
		agentRunning = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		maybeStopAnimation(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAnimation();
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = null;
		currentCtx = null;
		activeSubagents.clear();
		unsubscribeStarted();
		unsubscribeCompleted();
	});
}

export const __test = { BRAILLE_FRAMES, getTitle, sanitizeTitlePart };
