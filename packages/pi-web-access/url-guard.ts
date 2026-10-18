import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

export type UrlGuardReason =
	| "invalid_url"
	| "unsupported_protocol"
	| "missing_hostname"
	| "blocked_hostname"
	| "blocked_address";

export type UrlGuardResult =
	| { ok: true; url: URL }
	| { ok: false; reason: UrlGuardReason; message: string };

export type LookupAddress = { address: string; family?: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"metadata.google.internal",
	"metadata",
]);

function stripIpv6ZoneId(address: string): string {
	const normalized = address.toLowerCase();
	const zone = normalized.indexOf("%");
	return zone === -1 ? normalized : normalized.slice(0, zone);
}

function hexPairToIpv4(hiText: string, loText: string): string | undefined {
	if (!/^[0-9a-f]{1,4}$/i.test(hiText) || !/^[0-9a-f]{1,4}$/i.test(loText)) return undefined;
	const hi = Number.parseInt(hiText, 16);
	const lo = Number.parseInt(loText, 16);
	if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) {
		return undefined;
	}
	return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isIpv4MappedIpv6(address: string): string | undefined {
	const normalized = stripIpv6ZoneId(address);
	// Compressed ::ffff:x.x.x.x or ::ffff:hhhh:hhhh
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		if (net.isIP(mapped) === 4) return mapped;
		const hexParts = mapped.split(":");
		if (hexParts.length === 2) return hexPairToIpv4(hexParts[0]!, hexParts[1]!);
		return undefined;
	}
	// Expanded 0:0:0:0:0:ffff:x.x.x.x or 0:0:0:0:0:ffff:hhhh:hhhh
	const expandedDotted = normalized.match(/^(?:0{1,4}:){5}ffff:((?:\d{1,3}\.){3}\d{1,3})$/i);
	if (expandedDotted?.[1] && net.isIP(expandedDotted[1]) === 4) return expandedDotted[1];
	const expandedHex = normalized.match(/^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (expandedHex) return hexPairToIpv4(expandedHex[1]!, expandedHex[2]!);
	return undefined;
}

function isIpv6LinkLocal(address: string): boolean {
	// fe80::/10: first 10 bits are 1111111010, so first hextet is fe80-febf.
	const normalized = stripIpv6ZoneId(address);
	if (normalized.startsWith("::")) return false;
	const firstText = normalized.split(":", 1)[0] ?? "";
	if (!/^[0-9a-f]{1,4}$/i.test(firstText)) return false;
	const first = Number.parseInt(firstText, 16);
	return Number.isFinite(first) && (first & 0xffc0) === 0xfe80;
}

function isPrivateOrSpecialIpv4(address: string): boolean {
	const parts = address.split(".").map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return true;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / some metadata ranges
	if (a === 169 && b === 254) return true; // link-local / cloud metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 192 && b === 0 && parts[2] === 0) return true;
	if (a >= 224) return true; // multicast / reserved
	return false;
}

function isPrivateOrSpecialIpv6(address: string): boolean {
	const normalized = stripIpv6ZoneId(address);
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA
	if (isIpv6LinkLocal(normalized)) return true; // fe80::/10
	if (normalized.startsWith("ff")) return true; // multicast
	const mapped = isIpv4MappedIpv6(normalized);
	if (mapped) return isPrivateOrSpecialIpv4(mapped);
	return false;
}

export function isBlockedIpAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) return isPrivateOrSpecialIpv4(address);
	if (family === 6) return isPrivateOrSpecialIpv6(address);
	return true;
}

export function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.replace(/\.$/, "").toLowerCase();
	if (!normalized) return true;
	if (BLOCKED_HOSTNAMES.has(normalized)) return true;
	if (normalized.endsWith(".localhost")) return true;
	if (normalized.endsWith(".local")) return true;
	const bare = normalized.startsWith("[") && normalized.endsWith("]")
		? normalized.slice(1, -1)
		: normalized;
	if (net.isIP(bare)) return isBlockedIpAddress(bare);
	return false;
}

export function parseFetchUrl(input: string): UrlGuardResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, reason: "invalid_url", message: "URL must be a non-empty http(s) URL." };
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { ok: false, reason: "invalid_url", message: "URL must be a valid http(s) URL." };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { ok: false, reason: "unsupported_protocol", message: "Only http and https URLs can be fetched." };
	}
	if (!url.hostname) {
		return { ok: false, reason: "missing_hostname", message: "URL must include a hostname." };
	}
	if (url.username || url.password) {
		return { ok: false, reason: "invalid_url", message: "URLs containing credentials cannot be fetched." };
	}
	if (isBlockedHostname(url.hostname)) {
		return {
			ok: false,
			reason: "blocked_hostname",
			message: "URL hostname is blocked for local, private, or metadata destinations.",
		};
	}
	return { ok: true, url };
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("This operation was aborted", "AbortError");
}

async function raceWithSignalLocal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortReason(signal);
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

export async function assertFetchUrlAllowed(
	input: string,
	options: { lookup?: Lookup; resolveDns?: boolean; signal?: AbortSignal } = {},
): Promise<URL> {
	const parsed = parseFetchUrl(input);
	if (parsed.ok !== true) throw new Error(parsed.message);
	const url = parsed.url;
	if (options.signal?.aborted) throw abortReason(options.signal);
	// Default is static checks only. Agent-local DNS is not an authority for remote CDP:
	// the browser resolves names independently (split-horizon / rebinding).
	if (options.resolveDns !== true || net.isIP(url.hostname)) {
		if (net.isIP(url.hostname) && isBlockedIpAddress(url.hostname)) {
			throw new Error("URL address is blocked for local, private, or metadata destinations.");
		}
		return url;
	}
	const lookup = options.lookup ?? (async (hostname: string) => {
		const results = await dnsLookup(hostname, { all: true, verbatim: true });
		return results.map((item) => ({ address: item.address, family: item.family }));
	});
	let addresses: LookupAddress[];
	try {
		addresses = await raceWithSignalLocal(lookup(url.hostname), options.signal);
	} catch (error) {
		if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			throw error instanceof Error ? error : abortReason(options.signal!);
		}
		// Optional DNS path remains best-effort: resolution failure is not proof of safety.
		return url;
	}
	for (const item of addresses) {
		if (isBlockedIpAddress(item.address)) {
			throw new Error("URL hostname resolved to a blocked local, private, or metadata address.");
		}
	}
	return url;
}
