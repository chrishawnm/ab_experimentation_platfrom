import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/ab_experimentation_platfrom/",   // ← EXACT repo name
});
