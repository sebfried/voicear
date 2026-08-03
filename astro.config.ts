import { defineConfig } from "astro/config";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  server: { host: true },
  vite: {
    plugins: [basicSsl()],
    optimizeDeps: { include: ["@openai/agents/realtime", "onnxruntime-web/wasm", "zod"] }
  }
});
