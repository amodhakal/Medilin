import { Geist, Geist_Mono } from "next/font/google";

/**
 * react-toastify ships its own stylesheet and does not import it. Without this
 * line the toasts render as unstyled, unpositioned text in the top corner of
 * the body, which is how the failure and success messages this app relies on
 * went unseen for as long as they were there.
 *
 * Imported before globals.css on purpose: CSS is applied in import order, and
 * the overrides for these toasts live in globals.css, so importing this one
 * second would quietly undo them. Global CSS can only be imported from the
 * root layout, so this is the one place it can go at all.
 */
import "react-toastify/dist/ReactToastify.css";
import "./globals.css";

import { rootMetadata } from "@/i18n/metadata";
import { DisplayPreferences } from "@/i18n/display-preferences";
import { DEFAULT_LANGUAGE, messagesFor } from "@/i18n/registry";

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
 * There is no ToastContainer here. It moved to the language route, which is
 * the only page that raises toasts and the only place that knows the reading
 * direction of the page it is on; see src/app/language/[slug]/page.tsx.
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
        {/*
          The first thing in the tab order on every page. The language page is
          one form and the home page is a short list, so the alternative is
          tabbing through the chrome to reach either.
        */}
        <a className="skip-link" href="#main">
          {messagesFor(DEFAULT_LANGUAGE).skipToForm}
        </a>
        {/* Applies the low-bandwidth preference to the document. Renders
            nothing; see the file for why it is a component and not a script. */}
        <DisplayPreferences />
        {children}
      </body>
    </html>
  );
}
