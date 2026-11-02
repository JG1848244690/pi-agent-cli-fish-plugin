import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import test from "node:test";

import {
  ZipArchive,
  decodeEntities,
  htmlToParagraphs,
  isEpubPath,
  normalizePath,
  readEpubContent,
  resolveHref,
} from "../src/epub.ts";
import { loadBook } from "../src/reader.ts";

// --- a minimal zip writer so the fixtures are real archives -----------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: string | Buffer;
  deflate?: boolean;
}

function buildZip(files: ZipInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const body = file.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, "utf8");
    const method = file.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-fish-epub-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// --- fixtures --------------------------------------------------------------

function containerXml(opfPath: string): string {
  return `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function epub3Files(): ZipInput[] {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>剑来</dc:title>
    <dc:creator>烽火戏诸侯</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="Images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc"><ol>
      <li><a href="Text/ch1.xhtml">第一章 少年</a></li>
      <li><a href="Text/ch2.xhtml">第二章 夜行</a></li>
    </ol></nav>
  </body>
</html>`;

  const ch1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title>
<style>p { text-indent: 2em; }</style></head>
<body>
  <h1>第一章 少年</h1>
  <p>少年提着一盏灯&amp;走过长桥。</p>
  <p>A&nbsp;B&nbsp;&nbsp;C</p>
  <p/><p><br/></p>
  <p>&#31532;&#20108;&#27573;&#x3002;</p>
</body></html>`;

  const ch2 = `<html><body><h1>第二章 夜行</h1><p>夜里没有灯，只有雨。</p></body></html>`;

  return [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: containerXml("OEBPS/content.opf"), deflate: true },
    { name: "OEBPS/content.opf", data: opf, deflate: true },
    { name: "OEBPS/nav.xhtml", data: nav },
    { name: "OEBPS/Text/ch1.xhtml", data: ch1, deflate: true },
    { name: "OEBPS/Text/ch2.xhtml", data: ch2 },
  ];
}

function writeEpub(dir: string, name: string, files: ZipInput[]): string {
  const target = join(dir, name);
  writeFileSync(target, buildZip(files));
  return target;
}

// --- zip -------------------------------------------------------------------

test("reads stored and deflated zip entries", () => {
  const zip = new ZipArchive(
    buildZip([
      { name: "a.txt", data: "hello" },
      { name: "b/c.txt", data: "x".repeat(400), deflate: true },
    ]),
  );
  assert.equal(zip.has("a.txt"), true);
  assert.equal(zip.has("b/c.txt"), true);
  assert.equal(zip.text("a.txt"), "hello");
  assert.equal(zip.text("b/c.txt"), "x".repeat(400));
  assert.throws(() => zip.text("nope.txt"), /missing zip entry/);
});

test("rejects buffers that are not zips", () => {
  assert.throws(() => new ZipArchive(Buffer.from("plain text, not a zip")), /not an epub/);
});

// --- html ------------------------------------------------------------------

test("turns xhtml into trimmed paragraphs and remembers headings", () => {
  const { paragraphs, headings } = htmlToParagraphs(`<html><head><title>t</title>
    <style>.x{}</style><script>var a = 1;</script></head><body>
    <!-- comment -->
    <h1>标题</h1>
    <p>第一段<br/>第二行</p>
    <div>  多余   空白  </div>
    <p></p>
    </body></html>`);

  assert.deepEqual(paragraphs, ["标题", "第一段", "第二行", "多余 空白"]);
  assert.deepEqual(headings, [{ text: "标题", para: 0 }]);
});

test("merges hard-wrapped source lines but keeps blank-line paragraphs", () => {
  const wrapped = "<html><body><p>第一行文字\n第二行文字\n\n第三段開始\n第四行</p></body></html>";
  assert.deepEqual(htmlToParagraphs(wrapped).paragraphs, ["第一行文字第二行文字", "第三段開始第四行"]);

  const latin = "<html><body><p>hello\nworld</p></body></html>";
  assert.deepEqual(htmlToParagraphs(latin).paragraphs, ["hello world"]);

  // Installed spaces inside one source line are real and must survive.
  const spaced = "<html><body><h2>第一回 甄士隱夢幻識通靈</h2></body></html>";
  assert.deepEqual(htmlToParagraphs(spaced).paragraphs, ["第一回 甄士隱夢幻識通靈"]);
});

test("decodes named and numeric entities", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&apos;"), `&<>"'`);
  assert.equal(decodeEntities("&hellip;&mdash;&ldquo;引&rdquo;"), "…—\u201c引\u201d");
  assert.equal(decodeEntities("&#26085;&#x672c;"), "日本");
  assert.equal(decodeEntities("&nbsp;x"), " x");
  assert.equal(decodeEntities("&unknown;"), "&unknown;");
});

test("resolves hrefs against the opf directory", () => {
  assert.equal(normalizePath("OEBPS//Text/../Images/./a.jpg"), "OEBPS/Images/a.jpg");
  assert.equal(resolveHref("OEBPS", "Text/ch1.xhtml#p3"), "OEBPS/Text/ch1.xhtml");
  assert.equal(resolveHref("OEBPS/Text", "../Images/a%20b.jpg"), "OEBPS/Images/a b.jpg");
});

// --- epub ------------------------------------------------------------------

test("reads an EPUB3 book in spine order with nav chapter titles", () => {
  const file = writeEpub(tempDir(), "book.epub", epub3Files());
  const epub = readEpubContent(file);

  assert.deepEqual(epub.paragraphs, [
    "第一章 少年",
    "少年提着一盏灯&走过长桥。",
    "A B C",
    "第二段。",
    "第二章 夜行",
    "夜里没有灯，只有雨。",
  ]);
  assert.equal(epub.title, "剑来");
  assert.equal(epub.author, "烽火戏诸侯");
  assert.deepEqual(
    epub.chapters.map((chapter) => [chapter.para, chapter.title]),
    [
      [0, "第一章 少年"],
      [4, "第二章 夜行"],
    ],
  );
});

test("reads an EPUB2 book from toc.ncx and falls back to headings", () => {
  const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>老书</dc:title></metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="body" href="text/body.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="body"/></spine>
</package>`;
  const ncx = `<ncx><navMap>
    <navPoint id="n1"><navLabel><text>卷一 起点</text></navLabel><content src="text/body.html#p1"/></navPoint>
    <navPoint id="n2"><navLabel><text>卷二 终点</text></navLabel><content src="text/body.html#p2"/></navPoint>
  </navMap></ncx>`;
  const body = `<html><body>
    <h2>第1章 起</h2><p>一</p>
    <h2>第2章 落</h2><p>二</p>
    <h2>第3章 收</h2><p>三</p>
  </body></html>`;

  const file = writeEpub(tempDir(), "old.epub", [
    { name: "mimetype", data: "application/epub+zip" },
    { name: "META-INF/container.xml", data: containerXml("content.opf") },
    { name: "content.opf", data: opf, deflate: true },
    { name: "toc.ncx", data: ncx, deflate: true },
    { name: "text/body.html", data: body, deflate: true },
  ]);

  const epub = readEpubContent(file);
  assert.deepEqual(epub.paragraphs, [
    "第1章 起",
    "一",
    "第2章 落",
    "二",
    "第3章 收",
    "三",
  ]);
  // Two nav entries point into the same document, so headings win.
  assert.deepEqual(
    epub.chapters.map((chapter) => chapter.title),
    ["第1章 起", "第2章 落", "第3章 收"],
  );
});

test("loads an epub through loadBook like a text book", () => {
  const file = writeEpub(tempDir(), "book.epub", epub3Files());
  const book = loadBook(file);

  assert.equal(book.encoding, "epub");
  assert.equal(book.paragraphs.length, 6);
  assert.deepEqual(book.chapterParas, [0, 4]);
  assert.deepEqual(book.chapterTitles, ["第一章 少年", "第二章 夜行"]);
  assert.equal(book.chapterSet.has(4), true);
  assert.equal(book.totalChars, book.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0));
});

test("isEpubPath only matches the extension", () => {
  assert.equal(isEpubPath("/books/剑来.epub"), true);
  assert.equal(isEpubPath("/books/剑来.EPUB"), true);
  assert.equal(isEpubPath("/books/剑来.txt"), false);
});

test("reports broken epubs instead of throwing garbage", () => {
  const dir = tempDir();

  const noContainer = writeEpub(dir, "empty.epub", [{ name: "mimetype", data: "application/epub+zip" }]);
  assert.throws(() => readEpubContent(noContainer), /container\.xml/);

  const noOpf = writeEpub(dir, "noopf.epub", [
    { name: "META-INF/container.xml", data: containerXml("OEBPS/content.opf") },
  ]);
  assert.throws(() => readEpubContent(noOpf), /package document/);
});

test("skips non-linear spine items and missing documents", () => {
  const opf = `<package><manifest>
    <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
    <item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>
    <item id="c" href="gone.xhtml" media-type="application/xhtml+xml"/>
  </manifest><spine>
    <itemref idref="a"/><itemref idref="b" linear="no"/><itemref idref="c"/>
  </spine></package>`;
  const file = writeEpub(tempDir(), "spine.epub", [
    { name: "META-INF/container.xml", data: containerXml("content.opf") },
    { name: "content.opf", data: opf },
    { name: "a.xhtml", data: "<html><body><p>甲</p></body></html>" },
    { name: "b.xhtml", data: "<html><body><p>乙</p></body></html>" },
  ]);

  assert.deepEqual(readEpubContent(file).paragraphs, ["甲"]);
});
