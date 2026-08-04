import { defineConfig } from "astro/config";
import basicSsl from "@vitejs/plugin-basic-ssl";

const buildId = Date.now().toString(36);

export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  server: { host: true, headers: { "Cache-Control": "no-cache" } },
  vite: {
    define: { "import.meta.env.PUBLIC_VOICEAR_BUILD": JSON.stringify(buildId) },
    plugins: [basicSsl()],
    optimizeDeps: { include: ["@openai/agents/realtime", "onnxruntime-web/wasm", "zod"] }
  }
});
