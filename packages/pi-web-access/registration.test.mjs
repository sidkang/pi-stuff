import assert from "node:assert/strict";
import test from "node:test";
import webAccess from "./index.ts";

test("web-access registers web_search, x_search, and fetch_content", () => {
	const tools = new Map();
	const events = [];
	webAccess({
		on(event) {
			events.push(event);
		},
		registerTool(definition) {
			tools.set(definition.name, definition);
		},
	});

	assert.deepEqual([...tools.keys()], ["web_search", "x_search", "fetch_content"]);
	assert.equal(tools.get("web_search").label, "Web Search");
	assert.equal(tools.get("x_search").label, "X Search");
	assert.equal(tools.get("fetch_content").label, "Fetch Content");
	assert.deepEqual(tools.get("web_search").parameters.properties.provider.enum, ["openai", "xai", "exa", "firecrawl"]);
	assert.deepEqual(tools.get("web_search").parameters.required, ["query", "provider"]);
	assert.match(tools.get("web_search").parameters.properties.provider.description, /Required source/);
	assert.ok(tools.get("web_search").promptGuidelines.some((guideline) => guideline.includes("Always include a clear natural-language query and specify provider")));
	assert.equal(Object.hasOwn(tools.get("web_search").parameters.properties, "merge"), false);
	assert.deepEqual(Object.keys(tools.get("x_search").parameters.properties), ["query", "from_date", "to_date"]);
	assert.equal(tools.get("x_search").parameters.properties.from_date.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
	assert.equal(tools.get("x_search").parameters.properties.to_date.pattern, "^\\d{4}-\\d{2}-\\d{2}$");
	assert.equal(Object.hasOwn(tools.get("x_search").parameters.properties, "provider"), false);
	assert.deepEqual(Object.keys(tools.get("fetch_content").parameters.properties), ["url", "provider", "kernel"]);
	assert.deepEqual(tools.get("fetch_content").parameters.properties.provider.enum, ["cdp", "exa", "firecrawl"]);
	assert.deepEqual(tools.get("fetch_content").parameters.properties.kernel.enum, ["defuddle", "html-extractor", "llm"]);
	assert.match(tools.get("fetch_content").parameters.properties.kernel.description, /Ignored for exa and firecrawl/);
	assert.equal(Object.hasOwn(tools.get("fetch_content").parameters.properties, "provider"), true);
	assert.match(tools.get("web_search").parameters.properties.user_location.properties.country.description, /CN for China/);
	assert.match(tools.get("web_search").parameters.properties.user_location.properties.country.description, /Do not use country names/);
	assert.ok(events.includes("tool_result"));
	assert.ok(events.includes("session_shutdown"));
});
