/**
 * The watch plugin: what every session and run is doing, read from the journal, and a record when
 * one of them is stuck and when it is not any more.
 *
 * - **watch.get** and **watch.list** read the state of subjects now.
 * - **watch.stuck** and **watch.recovered** are written by a service that looks at the journal on
 *   a clock. Reacting is not the watch's business: a workflow subscribes to those records
 *   (`on: [{ type: "watch.stuck", filter: { kind: "silent" } }]`) and decides what to do.
 *
 * Records are read with a query by type name (`readings.ts`) and not through `api.on`: silence is
 * the absence of a record, so a handler per record could not see it, and a handler is an
 * invocation, which would write several records for every sign of life it was woken by. The
 * sessions, the workflows and the history are not imported, so the watch works with whichever of
 * them the host has installed.
 */

import { action, resolveQuery } from "@niwa-labs/core";
import type { StoredRecord } from "@niwa-labs/core";
import { plugin } from "@niwa-labs/plugin";
import type { Plugin } from "@niwa-labs/plugin";

import { DEFAULT_SETTINGS, Model, SOURCES, transitions } from "./readings.ts";
import type { Settings } from "./readings.ts";
import { WATCH_TYPES, WatchRecovered, WatchStuck, watchGet, watchList } from "./records.ts";

export * from "./records.ts";
export type { Settings } from "./readings.ts";

/** The limits of the watch; what is not given is the default. Durations are milliseconds. */
export interface WatchOptions extends Partial<Settings> {
  /** How often the service looks. Default: 15 seconds. */
  readonly tick?: number;
}

/** A subject the watch does not follow: no record named it, or it has ended. */
export class UnknownSubject extends Error {
  override name = "UnknownSubject";
  constructor(readonly subject: string) {
    super(`the watch does not follow ${subject}: no session or run of that name is working`);
  }
}

const DEFAULT_TICK = 15_000;

function settingsOf(options: WatchOptions): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...stripped(options) };
  for (const [name, value] of Object.entries({ ...settings, tick: options.tick ?? DEFAULT_TICK })) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`the watch setting "${name}" must be a positive number, got ${String(value)}`);
  }
  return settings;
}

/** The options that were given, without the ones left undefined. */
function stripped(options: WatchOptions): Partial<Settings> {
  const { tick: _tick, ...rest } = options;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Partial<Settings>;
}

/** The watch plugin. */
export function watch(options: WatchOptions = {}): Plugin {
  const settings = settingsOf(options);
  const tick = options.tick ?? DEFAULT_TICK;

  return plugin("watch", (api) => {
    api.declare(...WATCH_TYPES);

    const model = new Model();
    let cursor = 0;
    let clock: (() => number) | undefined;
    const now = (): number => clock?.() ?? Date.now();

    /** Fold the records written since the last look. */
    const sync = (): void => {
      const rows: StoredRecord[] = api.journal?.()?.query(resolveQuery({ types: SOURCES, from: cursor })) ?? [];
      for (const row of rows) {
        model.apply(row);
        cursor = row.seq;
      }
    };

    api.service((ctx) => {
      clock = () => ctx.now();
      model.startedAt(ctx.now());
      let stopped = false;
      let cancel = (): void => {};

      const look = async (): Promise<void> => {
        sync();
        for (const next of transitions(model.flags(), model.readings(ctx.now(), settings))) {
          if (next.type === "stuck") {
            const data = next.data;
            await ctx.emit(WatchStuck, data);
          } else {
            const data = next.data;
            await ctx.emit(WatchRecovered, data);
          }
        }
        // What was just written is read back, like any other record: the flags are those the journal holds,
        // which is also what keeps a restart from writing one twice.
        sync();
      };

      const arm = (): void => {
        cancel = ctx.schedule(ctx.now() + tick, async () => {
          try {
            await look();
          } catch (error) {
            // A host that is closing has no journal to write to; anything else is a real failure.
            if (api.journal?.() !== undefined && !stopped) throw error;
          } finally {
            if (!stopped) arm();
          }
        });
      };
      arm();
      return () => {
        stopped = true;
        cancel();
      };
    });

    api.action(
      action(watchGet, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          sync();
          const reading = model.readingOf(input.subject, now(), settings);
          if (reading === undefined) throw new UnknownSubject(input.subject);
          return reading;
        },
      }),
    );

    api.action(
      action(watchList, {
        recovery: "repeat",
        effect: "read",
        world: "niwa",
        run: (input) => {
          sync();
          return { subjects: model.readings(now(), settings).filter((one) => input.state === undefined || one.state === input.state) };
        },
      }),
    );

    api.summarize(() => {
      sync();
      const counts: Record<string, number> = {};
      for (const one of model.readings(now(), settings)) counts[one.state] = (counts[one.state] ?? 0) + 1;
      return counts;
    });
  });
}
