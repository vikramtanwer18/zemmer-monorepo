/** Runs once when the server starts: a bad config stops the server immediately. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEnv } = await import("./env");
    getEnv();
  }
}
