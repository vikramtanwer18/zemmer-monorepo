// Sign-in pages read the session and runtime settings on every request; never prerender them.
export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
