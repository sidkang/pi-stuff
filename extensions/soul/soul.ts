import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve } from "node:path";

const ANTI_OVERENGINEERING_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
const GLOBAL_CONTEXT_NAMES = new Set([
	"AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD",
]);
const ANTI_OVERENGINEERING_POLICY = `## Avoid Overengineering

- Do not add tests by default. For reversible, low-impact changes, skip new tests unless a concrete, meaningful failure risk justifies them.
- Never write tests that merely mirror the implementation, restate the code, or increase coverage without verifying meaningful behavior.
- Every new test must catch a plausible bug, protect a behavioral contract, or prevent a specific regression. If you cannot name the failure it catches and explain why that failure matters, do not write it.
- Keep verification proportional to risk. Use the smallest sufficient check. Do not introduce test scaffolding, mocks, abstractions, or unrelated refactors when a simpler check is adequate.`;

export default function soulExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!ANTI_OVERENGINEERING_MODELS.has(ctx.model?.id ?? "")) return;

		const agentDir = resolve(getAgentDir());
		const globalContext = event.systemPromptOptions.contextFiles.find((file) =>
			GLOBAL_CONTEXT_NAMES.has(basename(file.path)) &&
			resolve(dirname(file.path)) === agentDir,
		);
		// Pi supplies fresh context records for each agent run.
		if (globalContext) {
			globalContext.content += `\n\n${ANTI_OVERENGINEERING_POLICY}`;
			return;
		}
		// Without global context, extend the per-run prompt instead of project contexts.
		return { systemPrompt: `${event.systemPrompt}\n\n${ANTI_OVERENGINEERING_POLICY}` };
	});
}
