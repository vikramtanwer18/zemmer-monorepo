import { describe, expect, it } from "vitest";
import {
  createEmailSender,
  escapeHtml,
  MemoryEmailSender,
  otpEmail,
  staffInviteEmail,
} from "../src/email";

describe("email templates", () => {
  it("escapes every variable in the HTML", () => {
    const mail = staffInviteEmail({
      brand: "Gym",
      tenantName: `<script>alert("x")</script>`,
      inviterName: "Tom & Jerry",
      roles: ["Receptionist"],
      url: "https://app.example.test/invite/abc?x=1&y=2",
      expiresAt: new Date("2026-11-09T00:00:00Z"),
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("Tom &amp; Jerry");
    expect(mail.html).toContain("x=1&amp;y=2");
    expect(mail.text).toContain("https://app.example.test/invite/abc?x=1&y=2");
  });

  it("puts the OTP in the subject and body, with its expiry", () => {
    const mail = otpEmail({ brand: "Gym", code: "123456", minutes: 10 });
    expect(mail.subject).toContain("123456");
    expect(mail.text).toContain("expires in 10 minutes");
  });

  it("escapeHtml covers quotes", () => {
    expect(escapeHtml(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });
});

describe("memory sender", () => {
  it("keeps messages in memory and sends nothing", async () => {
    const sender = createEmailSender({ provider: "memory", from: "x@y.test" });
    expect(sender).toBeInstanceOf(MemoryEmailSender);
    await sender.send({
      to: "a@b.test",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    await sender.send({ to: "a@b.test", subject: "Again", html: "", text: "" });
    expect((sender as MemoryEmailSender).lastTo("a@b.test")?.subject).toBe(
      "Again",
    );
  });
});
