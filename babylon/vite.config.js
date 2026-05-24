import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2020",
    rollupOptions: {
      input: "./index.html",
    },
  },
  optimizeDeps: {
    include: ["@babylonjs/core", "@babylonjs/materials"],
  },
});
