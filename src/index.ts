import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { parseArgs, toProxyConfig, USAGE } from "./config.ts";
import { SdkCursorBackend } from "./cursor/sdkBackend.ts";

function main(argv: string[]): void {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (opts.port < 0) {
    console.log(USAGE);
    return;
  }

  const config = toProxyConfig(opts);
  const { app } = createApp(config, new SdkCursorBackend());
  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(
      `cursor-openai-proxy listening on http://${info.address}:${info.port} (${config.auth.mode}, session=${config.sessionMode}, mode=${config.agentMode})`,
    );
  });
}

main(process.argv.slice(2));
