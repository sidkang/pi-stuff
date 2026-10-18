import assert from "node:assert/strict";
import test from "node:test";
import applyPatch from "./index.ts";

test("apply-patch registers apply_patch and owns its visibility gate", () => {
	const tools = new Map();
	const events = [];
	applyPatch({
		on(event) {
			events.push(event);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
	});

	assert.deepEqual([...tools.keys()], ["apply_patch"]);
	assert.equal(tools.get("apply_patch").label, "Apply Patch");
	assert.deepEqual(Object.keys(tools.get("apply_patch").parameters.properties), ["input"]);
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("model_select"));
	assert.ok(events.includes("session_tree"));
	assert.ok(events.includes("before_agent_start"));
	assert.ok(events.includes("tool_call"));
	assert.ok(events.includes("session_shutdown"));
	assert.equal(events.includes("tool_result"), false);
});
