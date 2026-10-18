import fastMode from "./fast-mode.ts";
import { registerResponsesCompaction } from "./responses-compaction.ts";
import { registerCodeReview } from "./review/index.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codexTools(pi: ExtensionAPI) {
	fastMode(pi);
	registerResponsesCompaction(pi);
	registerCodeReview(pi);
}
