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
            offers: path.resolve(__dirname, "offers.html"),
            marketplace: path.resolve(__dirname, "marketplace.html"),
            album: path.resolve(__dirname, "album.html"),
            admin: path.resolve(__dirname, "admin.html"),
            overlay: path.resolve(__dirname, "overlay.html"),
          },
        },
      },
    },
  },
});
