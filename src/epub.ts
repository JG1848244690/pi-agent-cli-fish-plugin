/**
 * EPUB support: a dependency-free ZIP reader plus the slice of the EPUB spec
 * needed to turn a book into plain paragraphs — META-INF/container.xml → OPF
 * manifest/spine → XHTML, with chapter titles from nav.xhtml, toc.ncx or the
 * document headings. No import from ./reader.ts, so `reader.ts` can depend on
 * this module without a cycle.
 */

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export interface EpubChapter {
  /** Index into the returned paragraphs array. */
  para: number;
  title: string;
}

export interface EpubContent {
  paragraphs: string[];
  chapters: EpubChapter[];
  title?: string;
  author?: string;
}

export function isEpubPath(file: string): boolean {
  return /\.epub$/i.test(file.trim());
}

// ------------------------------------------------------------------- zip ----

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

export class ZipArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.readDirectory();
  }

  has(name: string): boolean {
    return this.entries.has(normalizePath(name));
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  read(name: string): Buffer {
    const entry = this.entries.get(normalizePath(name));
    if (!entry) throw new Error(`missing zip entry: ${name}`);

    const local = entry.offset;
    if (local + 30 > this.buf.length || this.buf.readUInt32LE(local) !== LOCAL_SIG) {
      throw new Error(`corrupt zip entry: ${name}`);
    }
    const nameLen = this.buf.readUInt16LE(local + 26);
    const extraLen = this.buf.readUInt16LE(local + 28);
    const start = local + 30 + nameLen + extraLen;
    const data = this.buf.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${entry.method} in ${name}`);
  }

  text(name: string): string {
    return this.read(name).toString("utf8").replace(/^\uFEFF/, "");
  }

  private readDirectory(): void {
    const eocd = this.findEndOfCentralDirectory();
    const count = this.buf.readUInt16LE(eocd + 10);
    const cdOffset = this.buf.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff) throw new Error("zip64 epub archives are not supported");

    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > this.buf.length || this.buf.readUInt32LE(p) !== CD_SIG) break;
      const method = this.buf.readUInt16LE(p + 10);
      const compressedSize = this.buf.readUInt32LE(p + 20);
      const size = this.buf.readUInt32LE(p + 24);
      const nameLen = this.buf.readUInt16LE(p + 28);
      const extraLen = this.buf.readUInt16LE(p + 30);
      const commentLen = this.buf.readUInt16LE(p + 32);
      const offset = this.buf.readUInt32LE(p + 42);
      const name = normalizePath(this.buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
      this.entries.set(name, { name, method, compressedSize, size, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }

    if (!this.entries.size) throw new Error("epub has no zip entries");
  }

  private findEndOfCentralDirectory(): number {
    const earliest = Math.max(0, this.buf.length - 0xffff - 22);
    for (let i = this.buf.length - 22; i >= earliest; i--) {
      if (this.buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    throw new Error("not an epub: no end of central directory record");
  }
}

// -------------------------------------------------------------- html/opf ----

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "",
  zwnj: "",
  lrm: "",
  rlm: "",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  times: "×",
  copy: "©",
  reg: "®",
  deg: "°",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

export interface Heading {
  text: string;
  /** Index into the returned paragraphs. */
  para: number;
}

const HEADING_OPEN = "\u0001";
const HEADING_CLOSE = "\u0002";
/** Marks a hard block boundary while source newlines are collapsed away. */
const BLOCK = "\u0004";
/** Marks a soft (wrapped) line break inside a block. */
const SOFT = "\u0005";

/** A wrapped line inside CJK text loses its break without a stray space. */
const CJK_SOFT_BREAK =
  /([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])[ \t\u3000]*\u0005+[ \t\u3000]*(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g;

/** Turn one XHTML document into trimmed paragraphs, remembering its headings. */
export function htmlToParagraphs(html: string): { paragraphs: string[]; headings: Heading[] } {
  const cleaned = html
    .replace(/\r\n?/g, "\n")
    // A blank line inside a block is a paragraph break in hard-wrapped sources.
    .replace(/[ \t]*\n[ \t]*\n[ \t]*(?:\n[ \t]*)*/g, BLOCK)
    .replace(/[ \t]*\n[ \t]*/g, SOFT)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!DOCTYPE[^>]*>/gi, " ")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<(script|style|title|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h[1-6]\b[^>]*>/gi, `${BLOCK}${HEADING_OPEN}`)
    .replace(/<\/h[1-6]>/gi, `${HEADING_CLOSE}${BLOCK}`)
    .replace(/<br\s*\/?>/gi, BLOCK)
    .replace(/<\/(p|div|li|tr|td|th|section|article|blockquote|pre|figcaption|dd|dt)>/gi, BLOCK)
    .replace(/<[^>]*>/g, "");

  const paragraphs: string[] = [];
  const headings: Heading[] = [];

  // Source documents are usually hard-wrapped at ~70 columns, so only the
  // block markers above may start a new paragraph; raw newlines are spaces.
  for (const raw of decodeEntities(cleaned).split(BLOCK)) {
    const marked = raw.includes(HEADING_OPEN) || raw.includes(HEADING_CLOSE);
    const text = raw
      .replace(/[\u0000-\u0003\u0006-\u001f]/g, " ")
      .replace(CJK_SOFT_BREAK, "$1")
      .replace(/\u0005+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (marked) headings.push({ text, para: paragraphs.length });
    paragraphs.push(text);
  }

  return { paragraphs, headings };
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[2] ?? match[3]) : undefined;
}

function decodeHref(href: string): string {
  return href
    .split("#")[0]
    .split("?")[0]
    .replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

export function resolveHref(baseDir: string, href: string): string {
  const clean = decodeHref(href.trim());
  if (clean.startsWith("/")) return normalizePath(clean);
  return normalizePath(baseDir ? `${baseDir}/${clean}` : clean);
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

interface ManifestItem {
  href: string;
  mediaType: string;
  properties: string;
  path: string;
}

interface Opf {
  dir: string;
  manifest: Map<string, ManifestItem>;
  spine: string[];
  tocId?: string;
  title?: string;
  author?: string;
}

function parseOpf(xml: string, opfPath: string): Opf {
  const dir = dirOf(opfPath);
  const manifest = new Map<string, ManifestItem>();

  const manifestBlock = /<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i.exec(xml)?.[1] ?? "";
  for (const match of manifestBlock.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(match[0], "id");
    const href = attr(match[0], "href");
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      mediaType: (attr(match[0], "media-type") ?? "").toLowerCase(),
      properties: (attr(match[0], "properties") ?? "").toLowerCase(),
      path: resolveHref(dir, href),
    });
  }

  const spineTag = /<spine\b[^>]*>/i.exec(xml)?.[0] ?? "";
  const spineBlock = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(xml)?.[1] ?? "";
  const spine: string[] = [];
  for (const match of spineBlock.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(match[0], "idref");
    if (!idref) continue;
    if ((attr(match[0], "linear") ?? "").toLowerCase() === "no") continue;
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.mediaType && !/^(application\/xhtml\+xml|text\/html|application\/xml|text\/xml)$/.test(item.mediaType)) {
      continue; // images/covers contribute no text
    }
    spine.push(item.path);
  }
  if (!spine.length) {
    // Broken/missing spine: fall back to manifest order for html documents.
    for (const item of manifest.values()) {
      if (/xhtml|text\/html/.test(item.mediaType) || /\.x?html?$/i.test(item.href)) spine.push(item.path);
    }
  }

  const metadata = /<metadata\b[^>]*>([\s\S]*?)<\/metadata>/i.exec(xml)?.[1] ?? xml;
  const title = decodeEntities(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(metadata)?.[1]?.trim() ?? "");
  const author = decodeEntities(
    /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(metadata)?.[1]?.trim() ?? "",
  );

  return {
    dir,
    manifest,
    spine,
    tocId: attr(spineTag, "toc"),
    title: title || undefined,
    author: author || undefined,
  };
}

/** Chapter links from either the EPUB3 nav document or the EPUB2 NCX. */
function readToc(zip: ZipArchive, opf: Opf): { path: string; title: string }[] {
  const out: { path: string; title: string }[] = [];

  const navItem = [...opf.manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  if (navItem && zip.has(navItem.path)) {
    const html = zip.text(navItem.path);
    const navBlock =
      /<nav\b[^>]*(?:epub:type\s*=\s*["']toc["'][^>]*)?>([\s\S]*?)<\/nav>/i.exec(html)?.[1] ?? html;
    for (const match of navBlock.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = match[2] ?? match[3] ?? "";
      const title = decodeEntities(match[4].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (!title) continue;
      out.push({ path: resolveHref(dirOf(navItem.path), href), title });
    }
  }
  if (out.length) return out;

  const ncx =
    [...opf.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml") ??
    (opf.tocId ? opf.manifest.get(opf.tocId) : undefined);
  if (ncx && zip.has(ncx.path)) {
    const xml = zip.text(ncx.path);
    const navDir = dirOf(ncx.path);
    for (const match of xml.matchAll(/<navPoint\b[^>]*>([\s\S]*?)<\/navPoint>/gi)) {
      const body = match[1];
      const title = decodeEntities(/<text\b[^>]*>([\s\S]*?)<\/text>/i.exec(body)?.[1] ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const src = attr(/<content\b[^>]*>/i.exec(body)?.[0] ?? "", "src");
      if (!title || !src) continue;
      out.push({ path: resolveHref(navDir, src), title });
    }
  }
  return out;
}

// -------------------------------------------------------------- epub read ----

/** Read an .epub into paragraphs plus chapter start positions. */
export function readEpubContent(file: string): EpubContent {
  const zip = new ZipArchive(readFileSync(file));

  const containerPath = ["META-INF/container.xml", "meta-inf/container.xml"].find((name) => zip.has(name));
  if (!containerPath) throw new Error("epub is missing META-INF/container.xml");
  const container = zip.text(containerPath);
  const rootTag = /<rootfile\b[^>]*>/i.exec(container)?.[0] ?? "";
  const opfPath = resolveHref("", attr(rootTag, "full-path") ?? "");
  if (!opfPath || !zip.has(opfPath)) throw new Error("epub is missing its package document (OPF)");

  const opf = parseOpf(zip.text(opfPath), opfPath);
  const toc = readToc(zip, opf);
  const spineIndex = new Map(opf.spine.map((path, index) => [path, index]));

  // First TOC entry per spine document wins; anchors inside one document fall
  // back to heading matching below.
  const docTitles = new Map<number, string>();
  const tocCount = new Map<number, number>();
  for (const entry of toc) {
    const index = spineIndex.get(entry.path);
    if (index === undefined) continue;
    tocCount.set(index, (tocCount.get(index) ?? 0) + 1);
    if (!docTitles.has(index)) docTitles.set(index, entry.title);
  }

  const paragraphs: string[] = [];
  const chapters: EpubChapter[] = [];

  opf.spine.forEach((path, index) => {
    if (!zip.has(path)) return;
    const { paragraphs: docParagraphs, headings } = htmlToParagraphs(zip.text(path));
    if (!docParagraphs.length) return;

    const base = paragraphs.length;
    const single = (tocCount.get(index) ?? 0) <= 1;
    const docTitle = single ? docTitles.get(index) : undefined;

    if (docTitle) chapters.push({ para: base, title: docTitle });

    headings.forEach((heading) => {
      const para = base + heading.para;
      if (para === base && docTitle) return;
      const known = chapters.some((chapter) => chapter.para === para);
      if (!known) chapters.push({ para, title: heading.text });
    });

    for (const paragraph of docParagraphs) paragraphs.push(paragraph);
  });

  return {
    paragraphs,
    chapters: chapters.filter((chapter) => chapter.para < paragraphs.length),
    title: opf.title,
    author: opf.author,
  };
}
