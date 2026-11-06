import { describe, expect, it } from "vitest";
import { createLogger } from "./index";

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (msg: string) => void lines.push(msg) } };
}

describe("logger", () => {
  it("never writes passwords or OTPs", () => {
    const { lines, stream } = capture();
    const log = createLogger({ name: "test", destination: stream });
    log.info(
      { email: "a@b.co", password: "hunter2", otp: "123456" },
      "sign in",
    );
    log.info(
      {
        user: { password: "nested-secret" },
        req: { headers: { authorization: "Bearer abc" } },
      },
      "nested",
    );

    const output = lines.join("\n");
    expect(output).toContain("a@b.co");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("nested-secret");
    expect(output).not.toContain("Bearer abc");
    expect(output).toContain("[REDACTED]");
  });
});
