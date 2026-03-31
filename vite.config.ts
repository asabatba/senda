import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	build: {
		rollupOptions: {
			input: {
				main: resolve(__dirname, "index.html"),
				tripExport: resolve(__dirname, "trip-export.html"),
			},
		},
	},
	server: {
		host: "0.0.0.0",
		port: 5173,
	},
});
