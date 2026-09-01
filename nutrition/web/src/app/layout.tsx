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
        {/*
          h-dvh + overflow-y-auto here, not min-h-dvh relying on document-level body
          scroll: in an installed PWA's standalone display mode, the outer shell does not
          reliably pass through native document scrolling the way an ordinary browser tab
          does. Making <main> itself the bounded, explicitly scrollable region works
          regardless of how the surrounding webview chrome behaves - confirmed necessary
          after every screen in the installed app turned out to be stuck non-scrolling.
        */}
        <main className="mx-auto flex h-dvh max-w-md flex-col overflow-y-auto overscroll-contain">
          {children}
        </main>
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
