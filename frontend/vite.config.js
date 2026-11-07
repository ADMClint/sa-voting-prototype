import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tailwind v4 ships as a Vite plugin, so no tailwind.config.js or PostCSS file is needed.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
