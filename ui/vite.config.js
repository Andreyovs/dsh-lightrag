import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" — приложение отдаётся по подпутью /lightrag-docs,
// поэтому пути к ассетам должны быть относительными.
export default defineConfig({
  base: "./",
  plugins: [react()],
});
