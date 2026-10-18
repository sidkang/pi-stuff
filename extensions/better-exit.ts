import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function betterExit(pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.source !== "interactive") {
			return { action: "continue" } as const;
		}

		if (event.images && event.images.length > 0) {
			return { action: "continue" } as const;
		}

		const text = event.text.trimEnd();
		if (text === "exit" || text === "quit" || text === ":q") {
			ctx.shutdown();
			return { action: "handled" } as const;
		}

		return { action: "continue" } as const;
	});
}
