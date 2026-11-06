import type { Metadata } from "next";
import { geistMono, geistSans } from "../_fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Test checkout",
  robots: { index: false },
};

/** Development-only pages (fake payment checkout). Each page 404s unless enabled. */
export default function DevLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
