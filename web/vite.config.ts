import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    // msgreader pulls in iconv-lite, which expects Node's Buffer/string_decoder.
    nodePolyfills({
      include: ["buffer", "string_decoder"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: { port: 5173 },
});
