/** The cockpit module of the memory plugin: what an agent remembers, its pages, and the questions waiting for the owner. */

import { definePlugin } from "@niwa-labs/cockpit-sdk";

import { MemoryPage } from "./page.tsx";

export default definePlugin({
  id: "memory",
  setup(ctx) {
    ctx.pages.add({
      path: "/memory",
      title: "Память",
      commandHeading: true,
      nav: { order: 65 },
      commands: [
        { action: "memory.note", label: "Добавить заметку" },
        { action: "memory.page.write", label: "Создать страницу или изменить её данные" },
        { action: "memory.search", label: "Найти запись" },
      ],
      component: MemoryPage,
    });
  },
});
