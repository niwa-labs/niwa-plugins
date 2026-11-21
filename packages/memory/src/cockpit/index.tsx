/** The cockpit module of the memory plugin: what an agent remembers, its pages, and the questions waiting for the owner. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { MemoryPage } from "./page.tsx";

export default definePlugin({
  id: "memory",
  setup(ctx) {
    ctx.pages.add({ path: "/memory", title: "Memory", nav: { order: 65 }, component: MemoryPage });
  },
});
