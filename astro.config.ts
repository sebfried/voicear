import { defineConfig } from "astro/config";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "never" },
  server: { host: true },
  vite: { plugins: [basicSsl()] }
});
