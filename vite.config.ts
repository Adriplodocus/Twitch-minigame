import path from "node:path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            main: path.resolve(__dirname, "index.html"),
            collection: path.resolve(__dirname, "collection.html"),
            trade: path.resolve(__dirname, "trade.html"),
            album: path.resolve(__dirname, "album.html"),
            admin: path.resolve(__dirname, "admin.html"),
          },
        },
      },
    },
  },
});
