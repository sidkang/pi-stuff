import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeUntrustedTerminalText } from "./terminal-text.ts";

test("sanitizeUntrustedTerminalText strips OSC52, OSC title, and CSI while preserving newline/tab/Unicode", () => {
	const osc52 = "safe\x1b]52;c;SGk=\x07tail";
	const oscTitle = "pre\x1b]0;evil-title\x07post";
	const csi = "a\x1b[2Jb\x1b[31mNOT_SGR_KEEP\x1b[0mc";
	const mixed = `标题\t一行\n${osc52}\n${oscTitle}\n${csi}`;

	const sanitized = sanitizeUntrustedTerminalText(mixed);
	assert.equal(sanitized.includes("\x1b"), false);
	assert.equal(sanitized.includes("\x07"), false);
	assert.match(sanitized, /标题/);
	assert.match(sanitized, /\t/);
	assert.match(sanitized, /\n/);
	assert.match(sanitized, /safe/);
	assert.match(sanitized, /tail/);
	assert.doesNotMatch(sanitized, /evil-title/);
	// Untrusted CSI/SGR payloads are removed entirely at the display boundary.
	assert.doesNotMatch(sanitized, /31m|0m/);
});

test("sanitizeUntrustedTerminalText strips C1 string controls and bidi marks", () => {
	const input = "ok\x9d0;title\x07mid\u202eexe\u2069end";
	const sanitized = sanitizeUntrustedTerminalText(input);
	assert.equal(sanitized.includes("\x9d"), false);
	assert.equal(sanitized.includes("\u202e"), false);
	assert.equal(sanitized.includes("\u2069"), false);
	assert.match(sanitized, /ok/);
	assert.match(sanitized, /end/);
});
