import type { Metadata } from "next";
import { geistMono, geistSans } from "../_fonts";
import "../globals.css";

export const metadata: Metadata = {
  robots: { index: false },
};

/** Public pages without an account: lead capture forms and trial passes. */
export default function PublicLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} min-h-dvh bg-background font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
