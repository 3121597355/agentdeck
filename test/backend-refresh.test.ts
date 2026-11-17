import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InboxBackend } from "../desktop/backend";

test("a forced backend refresh queues behind an active ordinary refresh", async () => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  const calls: boolean[] = [];
  const backend = new InboxBackend(
    { id: "windows", async send() {} },
    () => {},
    { node: process.execPath, cli: "unused" },
  );
  (backend as unknown as { performRefresh: (force: boolean) => Promise<void> }).performRefresh = async force => {
    calls.push(force);
    if (calls.length === 1) {
      started();
      await blocked;
    }
  };

  const active = backend.refresh();
  await began;
  const forced = backend.refresh(true);
  release();
  await Promise.all([active, forced]);

  assert.deepEqual(calls, [false, true], "the forced request must run again instead of being merged away");
});
