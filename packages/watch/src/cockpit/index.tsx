/** The cockpit module of the watch plugin: what every session and run is doing, and what was flagged as stuck. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { WatchPage } from "./page.tsx";

export default definePlugin({
  id: "watch",
  setup(ctx) {
    ctx.pages.add({ path: "/watch", title: "Watch", nav: { order: 50 }, component: WatchPage });
  },
});
