// Builds the dashboard into dist/dashboard. In development, /api goes to a running `howl serve`.
// @code_class reading
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: fileURLToPath(new URL("../../dist/dashboard", import.meta.url)), emptyOutDir: true },
  server: { proxy: { "/api": process.env.HOWL_SERVE_URL ?? "http://127.0.0.1:4317" } },
});
