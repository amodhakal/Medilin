import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ToastContainer } from "react-toastify";

import { rootMetadata } from "@/i18n/metadata";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Built in src/i18n/metadata.ts rather than here, so the referrer policy and
 * the robots policy are values that can be asserted on in a test. See that file
 * for why `referrer: "no-referrer"` is a privacy control and not a detail.
 */
export const metadata = rootMetadata;

/**
 * The document element.
 *
 * `lang` is fixed to English here because `<html>` can only be set by the root
 * layout, and the language of a document is not known until a route resolves
 * one. Each language route therefore declares its own `lang` and `dir` on the
 * subtree it owns, which is the part of the document that is actually in that
 * language. Moving the routes under a `[lang]` segment is the only way to get
 * this onto `<html>` itself, and that is a routing change, not a metadata one.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
