import { describe, expect, it } from "vitest";
import { createSecretBox } from "./secret-box";

const KEY = "test-key-material-0123456789abcdef-0123456789";
const OLD = "old-key-material-0123456789abcdef-0123456789";

describe("secret box (envelope encryption)", () => {
  it("round-trips and never stores the plaintext", () => {
    const box = createSecretBox({ key: KEY });
    const secret = Buffer.from("0123456789abcdef0123456789abcdef");
    const sealed = box.encrypt(secret);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain(secret.toString("base64url"));
    expect(box.decrypt(sealed).equals(secret)).toBe(true);
    // A fresh data key and IV every time.
    expect(box.encrypt(secret)).not.toBe(sealed);
  });

  it("rejects tampering", () => {
    const box = createSecretBox({ key: KEY });
    const sealed = box.encrypt("hello");
    const parts = sealed.split(".");
    const body = Buffer.from(parts[5]!, "base64url");
    body[0] = body[0]! ^ 1;
    parts[5] = body.toString("base64url");
    expect(() => box.decrypt(parts.join("."))).toThrow();
    expect(() => box.decrypt("garbage")).toThrow();
  });

  it("reads values sealed with the previous key during rotation", () => {
    const before = createSecretBox({ key: OLD });
    const sealed = before.encrypt("pass secret");
    const after = createSecretBox({ key: KEY, previousKey: OLD });
    expect(after.decrypt(sealed).toString()).toBe("pass secret");
    expect(after.needsRewrap(sealed)).toBe(true);
    expect(after.needsRewrap(after.encrypt("x"))).toBe(false);
    // Without the previous key it can't be read.
    expect(() => createSecretBox({ key: KEY }).decrypt(sealed)).toThrow(
      /unknown key/,
    );
  });
});
