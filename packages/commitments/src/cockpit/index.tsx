/** The cockpit module of the commitments plugin: every commitment as a card, with a way to cancel it. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { CommitmentsPage } from "./page.tsx";

export default definePlugin({
  id: "commitments",
  setup(ctx) {
    ctx.pages.add({ path: "/commitments", title: "Commitments", nav: { order: 45 }, component: CommitmentsPage });
  },
});
