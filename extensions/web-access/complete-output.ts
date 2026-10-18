import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_STRUCTURED_MARKDOWN_BYTES = 512 * 1024;
export const MAX_COMPLETE_MARKDOWN_BYTES = 64 * 1024 * 1024;
export const MAX_SESSION_SPILL_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_SPILL_FILES = 8;

/** Session-scoped, owner-only extracted markdown; never request headers or credentials. */
export function createCompleteOutputStore() {
	const directories = new Set<string>();
	let reservedBytes = 0;
	let reservedFiles = 0;
	let closing = false;
	const writes = new Set<Promise<unknown>>();
	async function prepare(markdown: string, signal?: AbortSignal) {
		if (closing) throw new Error("Complete-output storage is closed");
		if (signal?.aborted) throw signal.reason;
		const totalBytes = Buffer.byteLength(markdown, "utf8");
		if (totalBytes > MAX_COMPLETE_MARKDOWN_BYTES) throw new Error("Extracted markdown exceeded the 64 MiB complete-output limit");
		if (totalBytes <= MAX_STRUCTURED_MARKDOWN_BYTES) return { markdown, totalBytes, structuredChars: markdown.length, structuredTruncated: false };
		if (reservedFiles >= MAX_SESSION_SPILL_FILES || reservedBytes + totalBytes > MAX_SESSION_SPILL_BYTES) throw new Error("Session complete-output storage limit reached (8 files / 128 MiB)");
		// Reserve synchronously before filesystem awaits: sibling calls can run in parallel.
		reservedBytes += totalBytes;
		reservedFiles++;
		let directory: string | undefined;
		try {
			directory = await mkdtemp(join(tmpdir(), "pi-web-access-"));
			directories.add(directory);
			await chmod(directory, 0o700);
			const fullOutputPath = join(directory, "content.md");
			await writeFile(fullOutputPath, markdown, { encoding: "utf8", mode: 0o600, flag: "wx", signal });
			// No partial string enters QuickJS. Read the complete file with bounded read calls.
			return { markdown: "", totalBytes, structuredChars: 0, structuredTruncated: true, fullOutputPath };
		} catch (error) {
			if (directory) {
				await rm(directory, { recursive: true, force: true });
				directories.delete(directory);
			}
			reservedBytes -= totalBytes;
			reservedFiles--;
			throw error;
		}
	}
	return {
		prepare(markdown: string, signal?: AbortSignal) {
			const write = prepare(markdown, signal);
			writes.add(write);
			write.then(() => writes.delete(write), () => writes.delete(write));
			return write;
		},
		async clear() {
			closing = true;
			await Promise.allSettled([...writes]);
			await Promise.all([...directories].map(async (directory) => {
				await rm(directory, { recursive: true, force: true });
				directories.delete(directory);
			}));
			reservedBytes = 0;
			reservedFiles = 0;
		},
	};
}
