import { defineConfig, defineWorker } from "cf/config";

// A static site: `cf deploy` runs the Vite build and uploads dist/ as Worker
// static assets. Cache and security headers live in public/_headers.
export default defineConfig({
  // The Teich account (Oren's login also sees the AAC one).
  accountId: "02bd603968db4f77d62a3c447ee329a2",
  worker: defineWorker({
    name: "northbay-trails",
    compatibilityDate: "2026-11-04",
    domains: ["trails.teich.net"],
    workersDev: false,
    previewUrls: false,
    assets: {
      notFoundHandling: "404-page",
    },
  }),
});
