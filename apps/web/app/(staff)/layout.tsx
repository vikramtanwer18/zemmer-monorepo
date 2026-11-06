import type { Metadata } from "next";
import { geistMono, geistSans } from "../_fonts";
import "../globals.css";

export const metadata: Metadata = {
  title: "Gym Dashboard",
  description: "Gym staff dashboard",
};

export default function StaffLayout({
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
