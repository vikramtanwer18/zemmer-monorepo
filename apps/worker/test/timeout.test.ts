import { describe, expect, it } from "vitest";
import { JobTimeoutError, withTimeout } from "../src/worker";

describe("job timeout", () => {
  it("passes through results that arrive in time", async () => {
    await expect(
      withTimeout(Promise.resolve(42), 100, new AbortController(), "q/j"),
    ).resolves.toBe(42);
  });

  it("fails slow jobs and aborts their signal", async () => {
    const controller = new AbortController();
    const slow = new Promise((resolve) => setTimeout(resolve, 1_000));
    await expect(
      withTimeout(slow, 20, controller, "q/slow"),
    ).rejects.toBeInstanceOf(JobTimeoutError);
    expect(controller.signal.aborted).toBe(true);
  });
});
