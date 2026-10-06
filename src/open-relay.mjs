import { callHerdr } from "./herdr.mjs";

const pluginId = process.env.HERDR_PLUGIN_ID || "community.harness-relay";
const result = callHerdr([
  "plugin", "pane", "open",
  "--plugin", pluginId,
  "--entrypoint", "relay-console",
  "--placement", "tab",
]);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
