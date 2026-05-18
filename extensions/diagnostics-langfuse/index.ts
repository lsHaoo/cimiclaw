import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDiagnosticsLangfuseService } from "./src/service.js";

export default definePluginEntry({
  id: "diagnostics-langfuse",
  name: "Diagnostics Langfuse",
  description: "Export diagnostics events to Langfuse with full input/output and session support",
  register(api) {
    api.registerService(createDiagnosticsLangfuseService());
  },
});
