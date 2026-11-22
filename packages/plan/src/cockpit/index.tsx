/** The cockpit module of the plan plugin: the plans with their items and a look at any revision. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { PlansPage } from "./page.tsx";

export default definePlugin({
  id: "plan",
  setup(ctx) {
    ctx.pages.add({
      path: "/plans",
      title: "Планы",
      commandHeading: true,
      nav: { order: 55 },
      commands: [{ action: "plan.set", label: "Составить план" }],
      component: PlansPage,
    });
  },
});
