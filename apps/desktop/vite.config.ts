import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
// Relative assets are required when Electron loads the built renderer via file://.
export default defineConfig({ base: "./", plugins: [react()], root: path.join(__dirname, "renderer"), build: { outDir: path.join(__dirname, "renderer-dist"), emptyOutDir: true } });
