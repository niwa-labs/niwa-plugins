/** The cockpit module of the evidence plugin: the attestations of each subject and whether a requirement is covered. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { EvidencePage } from "./page.tsx";

export default definePlugin({
  id: "evidence",
  setup(ctx) {
    ctx.pages.add({
      path: "/evidence",
      title: "Evidence",
      nav: { order: 70 },
      commands: [{ action: "evidence.attest", label: "Добавить свидетельство" }],
      component: EvidencePage,
    });
  },
});
