import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nutrition Log",
  description: "Frictionless food logging",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Log" },
};

export const viewport: Viewport = {
  themeColor: "#0b0b0d",
  width: "device-width",
  initialScale: 1,
  // Prevents the double-tap zoom that otherwise fires while tapping portion chips.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/*
        Browser extensions (ColorZilla, LastPass, Grammarly and friends) inject attributes
        onto <body> before React hydrates, which React reports as a hydration mismatch.
        Suppressing it here keeps the dev overlay quiet so a genuine mismatch is visible
        rather than buried. This applies to attributes on this element only, not to any
        children, so real hydration bugs in the tree still surface.
      */}
      <body suppressHydrationWarning>
        <main className="mx-auto flex min-h-dvh max-w-md flex-col">{children}</main>
        <Script id="sw" strategy="afterInteractive">
          {`if ('serviceWorker' in navigator) {
              window.addEventListener('load', function () {
                navigator.serviceWorker.register('/sw.js').catch(function () {});
              });
            }`}
        </Script>
      </body>
    </html>
  );
}
