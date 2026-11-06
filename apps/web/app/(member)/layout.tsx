import type { Metadata, Viewport } from "next";
import { geistMono, geistSans } from "../_fonts";
import { RegisterServiceWorker } from "./register-sw";
import "../globals.css";

export const metadata: Metadata = {
  title: "My Gym",
  description: "Your gym membership, classes and check-in",
  manifest: "/m/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "My Gym",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/m/icon-192.png",
    apple: "/m/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#204289",
  width: "device-width",
  initialScale: 1,
};

export default function MemberLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        {children}
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
