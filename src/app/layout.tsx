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
        {/*
          `draggable` off: a drag handle is a mouse affordance with no keyboard
          equivalent, and on a form that is about to navigate it is a trap for
          anyone who grabs the wrong thing. `closeOnClick` off so clicking a
          toast cannot dismiss a message a patient has not read yet;
          `pauseOnFocusLoss` on so moving away to read a field does not take the
          message away from them.
        */}
        <ToastContainer
          position="top-center"
          draggable={false}
          closeOnClick={false}
          pauseOnFocusLoss
          closeButton
          autoClose={8000}
          newestOnTop
          role="alert"
        />
      </body>
    </html>
  );
}
