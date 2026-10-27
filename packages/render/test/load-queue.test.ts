import { expect, it } from "vitest";
import { LoadQueue } from "../src/load-queue.js";

it("bounds complete decode jobs and keeps draining after a failed or synchronously throwing load", async () => {
  const queue = new LoadQueue(3);
  let active = 0, peak = 0;
  const jobs = Array.from({ length: 30 }, (_, i) => queue.run(async () => {
    peak = Math.max(peak, ++active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (i === 2) throw new Error("decode failed");
      return i;
    } finally { active--; }
  }));
  const result = await Promise.allSettled(jobs);
  expect(peak).toBe(3);
  expect(active).toBe(0);
  expect(result[2]!.status).toBe("rejected");
  expect(result[29]).toEqual({ status: "fulfilled", value: 29 });
  await expect(queue.run(() => { throw new Error("sync failure"); })).rejects.toThrow("sync failure");
  await expect(queue.run(async () => "recovered")).resolves.toBe("recovered");
});
