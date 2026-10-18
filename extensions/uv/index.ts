import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getBlockedCommandMessage } from "./command-policy.ts";

const shimsPath = join(dirname(fileURLToPath(import.meta.url)), "shims");

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    createBashToolDefinition(process.cwd(), {
      commandPrefix: `export PATH="${shimsPath}:$PATH"`,
      spawnHook: (ctx) => {
        const message = getBlockedCommandMessage(ctx.command);
        if (message) throw new Error(message);
        return ctx;
      },
    }),
  );
}
