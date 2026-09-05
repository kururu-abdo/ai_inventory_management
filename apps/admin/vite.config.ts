import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  base: "./",
  // Keep dashboard configuration next to its app, not inside renderer source.
  envDir: __dirname,
  plugins: [react()],
  root: path.join(__dirname, "renderer"),
  build: { outDir: path.join(__dirname, "dist"), emptyOutDir: true },
});
