import assert from "node:assert/strict";
import test from "node:test";
import { assertFetchUrlAllowed, isBlockedIpAddress, parseFetchUrl } from "./url-guard.ts";

test("parseFetchUrl accepts public https URLs", () => {
	const result = parseFetchUrl(" https://example.com/path ");
	assert.equal(result.ok, true);
	assert.equal(result.url.href, "https://example.com/path");
});

test("parseFetchUrl rejects non-http protocols and blocked hostnames", () => {
	assert.equal(parseFetchUrl("file:///tmp/x").ok, false);
	assert.equal(parseFetchUrl("https://localhost/x").ok, false);
	assert.equal(parseFetchUrl("https://app.localhost/x").ok, false);
	assert.equal(parseFetchUrl("http://127.0.0.1/").ok, false);
	assert.equal(parseFetchUrl("http://169.254.169.254/latest").ok, false);
	assert.equal(parseFetchUrl("http://[::1]/").ok, false);
	assert.equal(parseFetchUrl("http://[::ffff:127.0.0.1]/").ok, false);
	assert.equal(parseFetchUrl("http://[::ffff:7f00:1]/").ok, false);
	assert.equal(parseFetchUrl("http://[0:0:0:0:0:ffff:127.0.0.1]/").ok, false);
	assert.equal(parseFetchUrl("http://[fe80::1]/").ok, false);
	assert.equal(parseFetchUrl("http://[fe90::1]/").ok, false);
	assert.equal(parseFetchUrl("http://[febf::1]/").ok, false);
});

test("parseFetchUrl rejects credential-bearing URLs without echoing credentials", () => {
	for (const input of ["https://user:secret@example.com/path", "https://user@example.com", "https://:secret@example.com"]) {
		const result = parseFetchUrl(input);
		assert.equal(result.ok, false);
		assert.match(result.message, /credentials/);
		assert.doesNotMatch(result.message, /user|secret/);
	}
});

test("isBlockedIpAddress covers private and metadata ranges", () => {
	assert.equal(isBlockedIpAddress("10.0.0.1"), true);
	assert.equal(isBlockedIpAddress("192.168.1.1"), true);
	assert.equal(isBlockedIpAddress("172.16.0.1"), true);
	assert.equal(isBlockedIpAddress("169.254.169.254"), true);
	assert.equal(isBlockedIpAddress("::ffff:7f00:1"), true);
	assert.equal(isBlockedIpAddress("0:0:0:0:0:ffff:127.0.0.1"), true);
	assert.equal(isBlockedIpAddress("0:0:0:0:0:ffff:7f00:1"), true);
	assert.equal(isBlockedIpAddress("8.8.8.8"), false);
});

test("IPv6 link-local blocking covers fe80::/10 boundaries", () => {
	assert.equal(isBlockedIpAddress("fe80::1"), true);
	assert.equal(isBlockedIpAddress("fe90::1"), true);
	assert.equal(isBlockedIpAddress("febf::abcd"), true);
	// fec0 is outside fe80::/10; do not block solely via the link-local rule.
	assert.equal(isBlockedIpAddress("fec0::1"), false);
	assert.equal(parseFetchUrl("http://[fec0::1]/").ok, true);
});

test("assertFetchUrlAllowed defaults to static checks without Agent-local DNS", async () => {
	// Hostname is not a denylisted literal; DNS is not consulted by default.
	const allowed = await assertFetchUrlAllowed("https://private.example", {
		lookup: async () => [{ address: "10.1.2.3" }],
	});
	assert.equal(allowed.hostname, "private.example");
	await assert.rejects(
		() => assertFetchUrlAllowed("http://127.0.0.1/secret"),
		/blocked/,
	);
	await assert.rejects(
		() => assertFetchUrlAllowed("https://localhost/x"),
		/blocked/,
	);
});

test("assertFetchUrlAllowed optional DNS path remains available when explicitly enabled", async () => {
	await assert.rejects(
		() => assertFetchUrlAllowed("https://private.example", {
			resolveDns: true,
			lookup: async () => [{ address: "10.1.2.3" }],
		}),
		/blocked/,
	);
	const allowed = await assertFetchUrlAllowed("https://public.example", {
		resolveDns: true,
		lookup: async () => [{ address: "1.1.1.1" }],
	});
	assert.equal(allowed.hostname, "public.example");
});
