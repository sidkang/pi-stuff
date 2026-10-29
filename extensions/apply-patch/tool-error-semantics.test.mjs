import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createEventBus,
	createExtensionRuntime,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent";
import { importHostModules } from "../../tests/pi-host.mjs";
import applyPatch from "./index.ts";

const { loadExtensionFromFactory, runAgentLoop } = await importHostModules(import.meta.url);

function assistantToolCall(name, args) {
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		message,
		response: {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: message };
				yield { type: "done", reason: "toolUse", message };
			},
			async result() {
				return message;
			},
		},
	};
}

async function registeredTool(factory, name, cwd, withPeerExtension) {
	const eventBus = createEventBus();
	const runtime = createExtensionRuntime();
	const extensions = [await loadExtensionFromFactory(factory, cwd, eventBus, runtime, `/virtual/apply-patch/${name}.ts`)];
	if (withPeerExtension) {
		extensions.push(await loadExtensionFromFactory(
			(pi) => pi.on("session_start", () => undefined),
			cwd,
			eventBus,
			runtime,
			"/virtual/peer-extension/index.ts",
		));
	}
	const runner = new ExtensionRunner(extensions, runtime, cwd, {}, {});
	const definition = runner.getToolDefinition(name);
	assert.ok(definition, `${name} was registered`);
	return { definition, runner };
}

async function runFailingTool(definition, params, ctx, runner) {
	const tool = {
		...definition,
		execute(toolCallId, args, signal, onUpdate) {
			return definition.execute(toolCallId, args, signal, onUpdate, ctx);
		},
	};
	const { message, response } = assistantToolCall(definition.name, params);
	const events = [];
	const messages = await runAgentLoop(
		[{ role: "user", content: [{ type: "text", text: "run the tool" }], timestamp: Date.now() }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{
			model: { provider: "test", id: "gpt-5.6", api: "openai-responses" },
			convertToLlm: () => [],
			async afterToolCall({ toolCall, args, result, isError }) {
				// Pi 1.4.0 stops the loop after a batch whose results all set `terminate`.
				if (!runner.hasHandlers("tool_result")) return { terminate: true };
				const hookResult = await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args,
					content: result.content,
					details: result.details,
					isError,
					usage: result.usage,
				});
				if (!hookResult) return { terminate: true };
				return {
					content: hookResult.content,
					details: hookResult.details,
					isError: hookResult.isError ?? isError,
					usage: hookResult.usage,
					terminate: true,
				};
			},
		},
		(event) => events.push(event),
		undefined,
		async () => response,
	);
	const end = events.find((event) => event.type === "tool_execution_end");
	const persisted = messages.find((entry) => entry.role === "toolResult" && entry.toolName === definition.name);
	assert.equal(end?.isError, true, `${definition.name} outer event is an error`);
	assert.equal(persisted?.isError, true, `${definition.name} persisted result is an error`);
	assert.equal(persisted?.toolCallId, message.content[0].id);
	return { end, persisted };
}

for (const withPeerExtension of [false, true]) {
	const composition = withPeerExtension ? "with another loaded extension" : "without another loaded extension";

	test(`Pi records apply_patch rejection as isError ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "apply-patch-error-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { definition, runner } = await registeredTool(applyPatch, "apply_patch", cwd, withPeerExtension);
			const result = await runFailingTool(definition, { input: "*** Begin Patch\nnot-a-header\n*** End Patch" }, {
				cwd,
				isProjectTrusted: () => true,
			}, runner);
			assert.match(result.persisted.content[0].text, /Expected patch file header/i);
			assert.deepEqual(result.persisted.details, {});
			assert.equal(result.end.result.details === undefined || Object.keys(result.end.result.details).length === 0, true);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});
}
