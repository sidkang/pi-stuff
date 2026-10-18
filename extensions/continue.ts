import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function continueExtension(pi: ExtensionAPI): void {
	pi.registerShortcut("ctrl+enter", {
		description: 'Send "continue" as a user message',
		handler: () => {
			// Pi ignores deliverAs while idle and requires it if streaming begins before
			// prompt admission completes, so one dispatch shape is safer than a state snapshot.
			pi.sendUserMessage("continue", { deliverAs: "steer" });
		},
	});
}
