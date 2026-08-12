import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Dev mode: the Agent Rewind API (demo or standalone) runs on 4820.
      "/api": "http://localhost:4820",
    },
  },
});
