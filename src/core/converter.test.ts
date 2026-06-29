import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMarkdown, htmlToMarkdown } from "./converter.js";
import type { ParsedEmail } from "./converter.js";

test("buildMarkdown renders headings, metadata and a bulleted attachments list", () => {
  const email: ParsedEmail = {
    subject: "Toplantı Notları",
    from: { name: "Ayşe Yılmaz", email: "ayse@example.com" },
    to: [{ name: "Mehmet Kılıç", email: "mehmet@example.com" }],
    cc: [{ email: "cc@example.com" }],
    date: "2026-06-29T08:30:00.000Z",
    attachments: ["rapor.pdf", "sunum.pptx"],
    bodyText: "Merhaba,\n\nGörüşmek üzere.\n\n- Madde bir\n- Madde iki",
  };

  const md = buildMarkdown(email);

  assert.match(md, /^# Toplantı Notları/);
  assert.match(md, /## Details/);
  assert.match(md, /## Attachments/);
  assert.match(md, /## Body/);

  assert.match(md, /- \*\*From:\*\* Ayşe Yılmaz <ayse@example\.com>/);
  assert.match(md, /- \*\*Cc:\*\* cc@example\.com/);
  assert.match(md, /- \*\*Date:\*\* 2026-06-29T08:30:00\.000Z/);

  assert.match(md, /- rapor\.pdf/);
  assert.match(md, /- sunum\.pptx/);

  assert.ok(md.includes("Görüşmek üzere."));
});

test("htmlToMarkdown converts HTML into readable Markdown", () => {
  const html =
    "<h2>Başlık</h2><p>İlk paragraf.</p><ul><li>Bir</li><li>İki</li></ul>";
  const md = htmlToMarkdown(html);

  assert.match(md, /## Başlık/);
  assert.match(md, /İlk paragraf\./);
  assert.match(md, /[-*]\s+Bir/);
  assert.match(md, /[-*]\s+İki/);
});
