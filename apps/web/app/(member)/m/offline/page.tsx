export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-xl font-semibold text-foreground">You are offline</h1>
      <p className="text-sm text-muted">Check your connection and try again.</p>
      <a
        href="/m/card"
        className="mt-4 text-sm font-medium text-primary underline"
      >
        Your check-in card works offline: open it
      </a>
    </main>
  );
}
