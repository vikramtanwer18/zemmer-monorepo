import type { JobContext } from "../context";

export async function systemPing(ctx: JobContext<"system", "system.ping">) {
  const { message } = ctx.envelope.data;
  ctx.log.info({ message }, "pong");
  return { reply: "pong", message };
}
