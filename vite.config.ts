import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev port; clearScreen off keeps Rust errors visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // When dogfooding Cuelight on its own repo, run worktrees and the
      // journal are created under .cuelight/ inside the project. Without this,
      // Vite watches those copies and force-reloads the UI in a loop.
      ignored: ["**/.cuelight/**", "**/worktrees/**"],
    },
  },
  build: {
    target: "es2022",
  },
});
