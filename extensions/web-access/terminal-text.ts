/**
 * Strip untrusted terminal controls at display boundaries.
 * Preserves newline/tab and Unicode; removes C0/C1 (except TAB/LF), ESC/OSC/CSI
 * sequences, and bidirectional format controls.
 *
 * Apply to untrusted fields before Theme/SGR wrapping so trusted plugin colors stay intact.
 * Model-facing tool content must not pass through this helper.
 */

function isUnsafeFormatCode(code: number): boolean {
	return code === 0x061c
		|| (code >= 0x200b && code <= 0x200f)
		|| (code >= 0x202a && code <= 0x202e)
		|| (code >= 0x2060 && code <= 0x206f)
		|| code === 0xfeff;
}

function stringTerminator(text: string, start: number, osc: boolean, cache: { noString: number; noOscBel: number }): number | undefined {
	const scanStart = Math.max(start, osc ? cache.noOscBel : cache.noString);
	for (let cursor = scanStart; cursor < text.length; cursor++) {
		const current = text.charCodeAt(cursor);
		if (current === 0x18 || current === 0x1a || current === 0x9c || (osc && current === 0x07)) {
			cache.noString = Math.max(cache.noString, cursor);
			if (osc) cache.noOscBel = Math.max(cache.noOscBel, cursor);
			return cursor;
		}
		if (current === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) {
			cache.noString = Math.max(cache.noString, cursor + 1);
			if (osc) cache.noOscBel = Math.max(cache.noOscBel, cursor + 1);
			return cursor + 1;
		}
	}
	cache.noString = Math.max(cache.noString, text.length);
	if (osc) cache.noOscBel = Math.max(cache.noOscBel, text.length);
	return undefined;
}

function csiTerminator(text: string, start: number): number | undefined {
	let intermediates = false;
	for (let cursor = start; cursor < text.length; cursor++) {
		const current = text.charCodeAt(cursor);
		if (current === 0x18 || current === 0x1a) return cursor;
		if (current >= 0x30 && current <= 0x3f) {
			if (intermediates) return undefined;
			continue;
		}
		if (current >= 0x20 && current <= 0x2f) {
			intermediates = true;
			continue;
		}
		if (current >= 0x40 && current <= 0x7e) return cursor;
		return undefined;
	}
	return undefined;
}

/** Remove hostile terminal controls while preserving TAB, LF, and Unicode text. */
export function sanitizeUntrustedTerminalText(text: string): string {
	if (typeof text !== "string" || text.length === 0) return typeof text === "string" ? text : "";
	const cache = { noString: 0, noOscBel: 0 };
	let out = "";
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 0x1b) {
			const next = text.charCodeAt(index + 1);
			if (next === 0x5b) {
				const terminator = csiTerminator(text, index + 2);
				index = terminator === undefined ? index + 1 : terminator;
				continue;
			}
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				const terminator = stringTerminator(text, index + 2, next === 0x5d, cache);
				index = terminator === undefined ? index + 1 : terminator;
				continue;
			}
			continue;
		}
		if (code === 0x9b) {
			const terminator = csiTerminator(text, index + 1);
			if (terminator !== undefined) index = terminator;
			continue;
		}
		if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
			const terminator = stringTerminator(text, index + 1, code === 0x9d, cache);
			if (terminator !== undefined) index = terminator;
			continue;
		}
		if (code === 0x0d) {
			if (text.charCodeAt(index + 1) === 0x0a) index++;
			out += "\n";
			continue;
		}
		if (code === 0x0a || code === 0x09) {
			out += text[index]!;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || isUnsafeFormatCode(code)) continue;
		out += text[index]!;
	}
	return out;
}
