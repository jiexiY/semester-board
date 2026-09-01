import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { workflow } from "workflow/vite";

export default defineConfig(({ mode }) => {
  const isOfflineBuild = mode === "offline";
  return {
    base: "./",
    plugins: isOfflineBuild ? [react()] : [react(), nitro(), workflow()],
    ...(isOfflineBuild ? {} : {
      nitro: {
        noExternals: true,
        serverDir: "./",
      },
    }),
    build: {
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      rollupOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  };
});
