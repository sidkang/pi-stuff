import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fetchContent from "./fetch-content.ts";
import webSearch from "./web-search.ts";
import xSearch from "./x-search-tool.ts";

export default function webAccess(pi: ExtensionAPI) {
	webSearch(pi);
	xSearch(pi);
	fetchContent(pi);
}
