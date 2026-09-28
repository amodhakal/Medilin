/**
 * A minimal PDF writer.
 *
 * Built by hand rather than pulled in, and the reason is worth stating plainly
 * because "fewer dependencies" is not usually enough to justify writing a file
 * format yourself.
 *
 * **What is being written is the most sensitive artefact this application
 * produces.** A transcript PDF is a patient's own account of why they telephoned,
 * in the words the voice agents used, and it is the one thing here that leaves
 * the system: a file in a downloads folder, forwarded to whoever the patient
 * forwards it to. The smallest surface that can produce that file is the right
 * one. A PDF library brings a compression stack, an image encoder, a font
 * parser, and a compression-bomb surface, none of which this needs, and all of
 * which would be shipped into the serverless function that renders the export.
 *
 * **The output is deliberately uncompressed.** A stream that is not deflated is
 * a stream whose `/Length` is its byte count and whose text is greppable, which
 * is what makes this file's own test able to assert both that the call is in
 * the PDF and that an unauthorised caller got no bytes at all. Compression is
 * not a control here: the file is a file the recipient chose to keep.
 *
 * **The two standard fonts, and nothing embedded.** A conforming PDF reader is
 * required to have Helvetica and Helvetica-Bold, so a transcript is a few
 * kilobytes of text plus two font references. No font is embedded, which also
 * means no font licensing travels with a patient's medical history.
 *
 * The cost is the ~300 lines below, and they are all things a reader checks:
 * byte-exact cross-reference offsets, `/Length` that matches the stream, the
 * literal-string escapes, and the WinAnsi encoding. `pdf.test.ts` parses the
 * cross-reference table back out of the finished file and seeks with it, because
 * that is the one thing this writer can get wrong in a way nothing else would
 * notice.
 *
 * Deliberately not supported, and each omission is a decision rather than a gap:
 * images, embedded fonts, encryption, links, outlines, and incremental updates.
 * A transcript needs none of them, and a writer that could do all of them would
 * be a writer nobody had read.
 */

/** US Letter, in PostScript points. Every reader on earth has it. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN_LEFT = 54;
const MARGIN_RIGHT = 54;
/** Room for the running footer, so body text never collides with it. */
const MARGIN_BOTTOM = 72;

const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT;

const TITLE_SIZE = 16;
const SUBTITLE_SIZE = 10;
const FIELD_SIZE = 10;
const SPEAKER_SIZE = 9;
const BODY_SIZE = 10.5;
const FOOTER_SIZE = 8;

const BODY_LEADING = 13.5;
const TURN_GAP = 9;

/**
 * A ceiling on the pages one document may occupy.
 *
 * The store already bounds a transcript to `TRANSCRIPT_LINE_LIMIT` lines, so
 * this is belt and braces. It exists because the other thing that reaches the
 * writer is a caller, and a call that produced forty thousand pages would be a
 * denial of service against whoever holds the link rather than a document
 * anybody asked for.
 */
export const MAX_PDF_PAGES = 60;

export interface PdfField {
  label: string;
  value: string;
}

export interface PdfTurn {
  /** Who spoke. Printed beside the line; not a person, which is why it is a string here. */
  speaker: string;
  /** Pre-formatted time, so the writer has no opinion about time zones. */
  at?: string;
  text: string;
}

export interface PdfDocument {
  title: string;
  subtitle: string;
  /** Header facts, printed as a label/value table under the title. */
  fields: readonly PdfField[];
  turns: readonly PdfTurn[];
  /** Printed at the foot of every page. */
  footer: string;
}

export { CONTENT_WIDTH };

/* -------------------------------------------------------------------------- */
/* Encoding                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The characters between ASCII and Latin-1 that a voice agent actually emits,
 * and where WinAnsi puts them.
 *
 * Curly quotes and dashes are the whole of this table, and they are here because
 * substituting them would be visible: an agent saying "it’s" would be printed as
 * "it?s" in the middle of a patient's sentence, and a reader of a medical
 * transcript cannot tell a transcription artefact from something that was said.
 */
const WINANSI_PUNCTUATION: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85, // …
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98,
  0x2122: 0x99, // ™
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f,
};

/**
 * Map a string to the bytes WinAnsiEncoding means, one byte per character.
 *
 * Two substitutions, and they are different on purpose.
 *
 * **A character the encoding cannot name becomes `?`.** A byte a reader has no
 * glyph for is rendered as *nothing*, so the sentence would look like it had a
 * hole in it and the missing word would be unrecoverable. A question mark is
 * visible, and a visible artefact can be noticed.
 *
 * **A control character is kept.** A NUL in a transcript is a bug in whatever
 * produced it, not a word, and it has a byte in WinAnsi; `literal` writes it as
 * an octal escape, which is the correct way to put an unprintable byte in a PDF
 * string. Substituting it would be second-guessing an input that the writer's
 * job is to reproduce faithfully.
 */
export function toWinAnsi(text: string): string {
  let out = "";

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (code >= 0x20 && code <= 0x7e) {
      out += character;
      continue;
    }

    const mapped = WINANSI_PUNCTUATION[code];
    if (mapped !== undefined) {
      out += String.fromCharCode(mapped);
      continue;
    }

    if ((code >= 0x00 && code <= 0x1f) || (code >= 0xa0 && code <= 0xff)) {
      out += String.fromCharCode(code);
      continue;
    }

    out += "?";
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Helvetica's glyph widths, in 1/1000 em, for codes 32 to 126.
 *
 * The real AFM numbers, because a wrap computed from an average character width
 * either leaves ragged right edges or runs text past the margin, and the second
 * of those is invisible: a reader simply does not show the overflow.
 *
 * Anything outside the table -- the handful of typographic characters
 * `toWinAnsi` lets through -- is measured as an average letter. They are
 * punctuation in running text, so a one-character error in a wrap decision is
 * not worth a second table.
 */
const HELVETICA_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** The width of `text` at `size` points, in points. */
export function fitText(text: string, size: number): number {
  let total = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const width =
      code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : undefined;
    total += (width ?? 556) / 1000;
  }

  return total * size;
}

/**
 * Break a paragraph into lines that each fit `maxWidth`.
 *
 * A greedy fill, which is what a typesetter does and what a word processor
 * does, and it is one pass. A word wider than the column -- a URL, a drug name,
 * a patient spelling out a number -- is broken between characters rather than
 * allowed past the margin, because the alternative is text that leaves the page
 * and is simply absent from the document.
 *
 * Whitespace is collapsed first: a line that had been wrapped would otherwise
 * carry its break into the next line as leading space, and a transcript is full
 * of the double spaces the agents' own segmentation produces.
 */
export function wrapText(text: string, size: number, maxWidth: number): string[] {
  const words = toWinAnsi(text).replace(/\s+/g, " ").trim();
  if (words === "") return [""];

  // A column narrower than a single character would never fit one, and the loop
  // below would make no progress. One character per line terminates, which is
  // ugly and finite, and a zero-width page is a bug in the caller rather than
  // something to hang a request over.
  if (maxWidth <= 0) return words.split("");

  const lines: string[] = [];
  let current = "";

  for (const word of words.split(" ")) {
    for (const piece of breakWord(word, size, maxWidth)) {
      const candidate = current === "" ? piece : `${current} ${piece}`;

      if (current !== "" && fitText(candidate, size) > maxWidth) {
        lines.push(current);
        current = piece;
        continue;
      }

      current = candidate;
    }
  }

  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

/** Break one word into pieces that each fit, character-wise if it has to. */
function breakWord(word: string, size: number, maxWidth: number): string[] {
  if (fitText(word, size) <= maxWidth) return [word];

  const pieces: string[] = [];
  let current = "";

  for (const character of word) {
    if (current !== "" && fitText(current + character, size) > maxWidth) {
      pieces.push(current);
      current = character;
      continue;
    }
    current += character;
  }

  if (current !== "") pieces.push(current);
  return pieces;
}

/* -------------------------------------------------------------------------- */
/* Building the file                                                            */
/* -------------------------------------------------------------------------- */

/** A PDF string, as literal syntax. Every character is escaped or substituted. */
function literal(text: string): string {
  let out = "(";

  for (const character of toWinAnsi(text)) {
    const code = character.charCodeAt(0);

    if (character === "\\" || character === "(" || character === ")") {
      out += `\\${character}`;
      continue;
    }

    // A byte below 0x20, or above ASCII, inside a literal string has to be
    // written as an octal escape. A raw control byte is illegal in a stream and
    // a reader that tolerates one truncates the string there, so the rest of a
    // patient's sentence would be silently dropped. Always three digits, so a
    // following digit cannot be absorbed into the escape.
    if (code < 0x20 || code > 0x7e) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
      continue;
    }

    out += character;
  }

  return `${out})`;
}

/** `D:YYYYMMDDHHmmSS+HH'MM'`, which is what a PDF date has to look like. */
function pdfDate(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);

  return (
    `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}'${pad(absolute % 60)}'`
  );
}

/** One drawn line: a position, a font, a colour, and the text. */
interface Run {
  y: number;
  /** Absolute x. Left margin unless a run is placed inline after a label. */
  x?: number;
  font: "F1" | "F2";
  size: number;
  grey: number;
  text: string;
}

interface Page {
  runs: Run[];
}

/**
 * Lay the document out into pages.
 *
 * Positioning is done here, in points, and the result is a list of runs per
 * page -- so the byte-level work in `renderPdf` has no arithmetic in it and
 * cannot be wrong about a margin.
 */
function layout(document: PdfDocument): Page[] {
  const pages: Page[] = [];
  let runs: Run[] = [];
  let y = PAGE_HEIGHT - 56;

  const page = (): void => {
    pages.push({ runs });
    runs = [];

    // Checked as the pages are made rather than at the end, so a caller that
    // hands over a hundred thousand lines is refused after a bounded amount of
    // work rather than after all of it. "The export produced a forty-thousand
    // page PDF" is a denial of service against whoever holds the link, and it is
    // cheaper to refuse than to investigate.
    if (pages.length > MAX_PDF_PAGES) {
      throw new Error(
        `Refusing to build a transcript PDF of more than ${MAX_PDF_PAGES} pages.`,
      );
    }
  };

  const room = (): boolean => y > MARGIN_BOTTOM;

  runs.push({ y, font: "F2", size: TITLE_SIZE, grey: 0, text: document.title });
  y -= TITLE_SIZE + 6;
  runs.push({ y, font: "F1", size: SUBTITLE_SIZE, grey: 0.4, text: document.subtitle });
  y -= SUBTITLE_SIZE + 10;

  for (const field of document.fields) {
    if (!room()) {
      page();
      y = PAGE_HEIGHT - 56;
    }
    runs.push({ y, font: "F2", size: FIELD_SIZE, grey: 0.35, text: `${field.label}:` });
    const labelWidth = fitText(`${field.label}: `, FIELD_SIZE);
    runs.push({
      y,
      font: "F1",
      size: FIELD_SIZE,
      grey: 0,
      text: field.value,
    });
    // The value is placed after the label on the same baseline, so a long label
    // cannot run the value off the right-hand edge.
    shiftLastRun(runs, MARGIN_LEFT + labelWidth);
    y -= FIELD_SIZE + 4;
  }

  y -= 6;

  if (document.turns.length === 0) {
    runs.push({
      y,
      font: "F1",
      size: BODY_SIZE,
      grey: 0.4,
      text: "No conversation was recorded for this appointment.",
    });
    y -= BODY_LEADING;
  }

  for (const turn of document.turns) {
    const speaker = turn.at ? `${turn.speaker}  ${turn.at}` : turn.speaker;
    const body = wrapText(turn.text, BODY_SIZE, CONTENT_WIDTH);

    if (!room()) {
      page();
      y = PAGE_HEIGHT - 56;
    }

    runs.push({ y, font: "F2", size: SPEAKER_SIZE, grey: 0.4, text: speaker });
    y -= SPEAKER_SIZE + 3;

    for (const line of body) {
      if (!room()) {
        page();
        y = PAGE_HEIGHT - 56;
      }
      runs.push({ y, font: "F1", size: BODY_SIZE, grey: 0, text: line });
      y -= BODY_LEADING;
    }

    y -= TURN_GAP;
  }

  pages.push({ runs });
  return pages;
}

/** Move the run that was just added to an absolute x, for inline layout. */
function shiftLastRun(runs: Run[], x: number): void {
  const last = runs[runs.length - 1];
  if (last) last.x = x;
}

/** The content stream for one page, plus the footer. */
function contentStream(page: Page, pageNumber: number, total: number, footer: string): string {
  const parts: string[] = ["q"];

  for (const run of page.runs) {
    const x = run.x ?? MARGIN_LEFT;
    parts.push(
      `${run.grey.toFixed(2)} g`,
      `BT /${run.font} ${run.size} Tf 1 0 0 1 ${round(x)} ${round(run.y)} Tm ${literal(run.text)} Tj ET`,
    );
  }

  // The footer is the same on every page, and it is drawn last so it sits over
  // nothing: `MARGIN_BOTTOM` is the floor the body is not allowed below, so the
  // two cannot collide.
  parts.push("0.45 g");
  parts.push(
    `BT /F1 ${FOOTER_SIZE} Tf 1 0 0 1 ${MARGIN_LEFT} ${MARGIN_BOTTOM - 24} Tm ${literal(footer)} Tj ET`,
  );
  parts.push(
    `BT /F1 ${FOOTER_SIZE} Tf 1 0 0 1 ${round(PAGE_WIDTH - MARGIN_RIGHT - 62)} ${MARGIN_BOTTOM - 24} Tm ${literal(`Page ${pageNumber} of ${total}`)} Tj ET`,
  );
  parts.push("0 g", "Q");

  return parts.join("\n");
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Serialise a document to PDF bytes.
 *
 * A cross-reference table is a list of byte offsets, so the file is assembled as
 * a list of byte codes and every object's position is measured rather than
 * computed. The table is written in the fixed-width 20-byte entry form with
 * three-digit generations, because that is what the specification requires and
 * a reader is entitled to parse it byte by byte.
 */
export function renderPdf(document: PdfDocument, generatedAt: Date = new Date()): Uint8Array {
  const pages = layout(document);

  // 1 catalog, 2 page tree, then a page and a content stream per page, then two
  // fonts, then the document information dictionary.
  const fontRegular = 3 + pages.length * 2;
  const fontBold = fontRegular + 1;
  const info = fontBold + 1;
  const size = info + 1;

  const bytes: number[] = [];
  const offsets: number[] = [];

  const write = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes.push(text.charCodeAt(index));
  };

  const object = (number: number, body: string): void => {
    offsets[number] = bytes.length;
    write(`${number} 0 obj\n${body}\nendobj\n`);
  };

  write("%PDF-1.4\n");

  object(1, "<< /Type /Catalog /Pages 2 0 R >>");

  const kids = pages.map((_unused, index) => `${3 + index * 2} 0 R`).join(" ");
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((page, index) => {
    const pageNumber = 3 + index * 2;
    const contentNumber = pageNumber + 1;
    const stream = contentStream(page, index + 1, pages.length, document.footer);

    object(
      pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>`,
    );

    // `/Length` is the stream's byte count, counted the same way the bytes were
    // laid down: one byte per character, which is exact because `toWinAnsi` has
    // already reduced the text to single-byte codes and everything structural
    // is ASCII.
    object(
      contentNumber,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });

  for (const [number, baseFont] of [
    [fontRegular, "Helvetica"],
    [fontBold, "Helvetica-Bold"],
  ] as const) {
    object(
      number,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`,
    );
  }

  object(
    info,
    `<< /Title ${literal(document.title)} /Producer ${literal("Medilin")} ` +
      `/Creator ${literal("Medilin")} /CreationDate ${literal(pdfDate(generatedAt))} >>`,
  );

  const xrefOffset = bytes.length;
  write(`xref\n0 ${size}\n`);
  write("0000000000 65535 f \n");
  for (let number = 1; number < size; number += 1) {
    write(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  }

  write(
    `trailer\n<< /Size ${size} /Root 1 0 R /Info ${info} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Uint8Array.from(bytes);
}
