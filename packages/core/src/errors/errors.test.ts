import { describe, expect, it } from "vitest";
import { AppError, ERROR_STATUS, toActionError } from "./index";

describe("errors", () => {
  it("maps codes to HTTP status", () => {
    expect(new AppError("NOT_FOUND", "Member not found").status).toBe(404);
    expect(ERROR_STATUS.FORBIDDEN).toBe(403);
  });

  it("passes AppError code and message through", () => {
    expect(toActionError(new AppError("CONFLICT", "Already exists"))).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "Already exists" },
    });
  });

  it("never exposes the message of unknown errors", () => {
    const result = toActionError(
      new Error('relation "app.members" does not exist'),
    );
    expect(result.error.code).toBe("INTERNAL");
    expect(result.error.message).not.toContain("relation");
    expect(toActionError("raw string").error.code).toBe("INTERNAL");
  });
});
