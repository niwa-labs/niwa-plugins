/** The cockpit module of the forge plugin: watched repositories, pull requests with their pipelines, and armed merges. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { ForgePage } from "./page.tsx";

export default definePlugin({
  id: "forge",
  setup(ctx) {
    ctx.pages.add({ path: "/forge", title: "Forge", nav: { order: 60 }, component: ForgePage });
  },
});
