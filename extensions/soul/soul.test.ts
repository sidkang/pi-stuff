import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";

// Root tests do not install Pi. Stub its directory API; CLI E2E uses real Pi.
const agentDir = resolve("soul-test-profile");
const require = createRequire(import.meta.url);
const compiled = transformSync(readFileSync(new URL("./soul.ts", import.meta.url), "utf8"), {
	loader: "ts", format: "cjs",
}).code;
const module = { exports: {} as { default: (pi: any) => void } };
new Function("require", "module", "exports", compiled)(
	(name: string) => name === "@earendil-works/pi-coding-agent"
		? { getAgentDir: () => agentDir } : require(name),
	module, module.exports,
);
let handler: (event: any, ctx: any) => { systemPrompt: string } | undefined;
module.exports.default({ on: (_name: string, callback: typeof handler) => { handler = callback; } });

const policy = `## Avoid Overengineering

- Do not add tests by default. For reversible, low-impact changes, skip new tests unless a concrete, meaningful failure risk justifies them.
- Never write tests that merely mirror the implementation, restate the code, or increase coverage without verifying meaningful behavior.
- Every new test must catch a plausible bug, protect a behavioral contract, or prevent a specific regression. If you cannot name the failure it catches and explain why that failure matters, do not write it.
- Keep verification proportional to risk. Use the smallest sufficient check. Do not introduce test scaffolding, mocks, abstractions, or unrelated refactors when a simpler check is adequate.`;
const project = { path: resolve("project/AGENTS.md"), content: "Project instructions" };

const basePrompt = "Role prompt\n\nManager prompt";

function run(id: string | undefined, files: { path: string; content: string }[]) {
	return handler(
		{ systemPrompt: basePrompt, systemPromptOptions: { contextFiles: files } },
		{ model: id ? { id } : undefined },
	);
}

function globalFile(name = "AGENTS.md") {
	return { path: join(agentDir, name), content: "Global instructions\n" };
}

test("target models append only to global content, preserving paths and project instructions", () => {
	for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
		const global = globalFile();
		const original = { ...global };
		const files = [global, { ...project }];
		run(id, files);
		assert.deepEqual(files, [
			{ ...original, content: `${original.content}\n\n${policy}` },
			project,
		]);
	}
});

test("unlisted or absent models leave global context unchanged", () => {
	for (const id of [undefined, "gpt-6.1-sol-extra", "gpt-5.6-sol", "gpt-5.6-terra"]) {
		const files = [globalFile(), { ...project }];
		const original = structuredClone(files);
		run(id, files);
		assert.deepEqual(files, original);
	}
});

test("global context alternatives are supported without matching unrelated files", () => {
	for (const name of ["AGENTS.override.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
		const global = globalFile(name);
		run("gpt-6-astra", [global]);
		assert.equal(global.content, `Global instructions\n\n\n${policy}`);
	}
	const unrelated = globalFile("README.md");
	run("gpt-6-astra", [unrelated]);
	assert.equal(unrelated.content, "Global instructions\n");
});

test("missing global context appends policy to the system prompt and leaves contexts untouched", () => {
	for (const files of [[], [{ ...project }], [globalFile("README.md")]]) {
		const original = structuredClone(files);
		for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]) {
			assert.deepEqual(run(id, files), { systemPrompt: `${basePrompt}\n\n${policy}` });
			assert.deepEqual(files, original);
		}
	}
});

test("non-target models get no fallback without global context", () => {
	for (const id of [undefined, "gpt-6.1-sol-extra", "gpt-5.6-sol"]) {
		const files = [{ ...project }];
		assert.equal(run(id, files), undefined);
		assert.deepEqual(files, [project]);
	}
});

test("global context path returns no system prompt override", () => {
	const global = globalFile();
	assert.equal(run("gpt-6-astra", [global, { ...project }]), undefined);
	assert.equal(global.content, `Global instructions\n\n\n${policy}`);
});

test("fresh per-run inputs do not accumulate the policy", () => {
	for (let i = 0; i < 2; i++) {
		assert.deepEqual(run("gpt-6-astra", [{ ...project }]), {
			systemPrompt: `${basePrompt}\n\n${policy}`,
		});
		const global = globalFile();
		run("gpt-6-astra", [global]);
		assert.equal(global.content, `Global instructions\n\n\n${policy}`);
	}
});
