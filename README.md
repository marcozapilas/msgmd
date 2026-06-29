# msgmd

A small, local command-line utility that converts Outlook `.msg` files into clean,
readable Markdown. It extracts the message metadata (subject, sender, recipients,
date, attachments) and the body, converting an HTML body into Markdown when one is
present and preserving paragraphs/lists for plain-text bodies.

- 100% local — nothing leaves your machine.
- Accepts a single `.msg` file **or** a folder of `.msg` files.
- Writes `.md` files into an `output/` folder.
- Handles Turkish characters (ç, ğ, ı, İ, ö, ş, ü) correctly via UTF-8.
- Skips corrupted/unreadable files and keeps going, then prints a summary report.

## Architecture

The pipeline is split into small, single-responsibility modules:

| Module             | Responsibility                                                                 |
| ------------------ | ------------------------------------------------------------------------------ |
| `src/parser.ts`    | Read a `.msg` with `@kenjiuno/msgreader` and map it to a typed `ParsedEmail`.   |
| `src/markdown.ts`  | Turn a `ParsedEmail` into a Markdown document (HTML → Markdown via `turndown`). |
| `src/cli.ts`       | Discover input files, orchestrate conversion, write output, report a summary.   |
| `src/index.ts`     | Thin executable entry point (`#!/usr/bin/env node`).                            |
| `src/types.ts`     | Shared interfaces (`Address`, `ParsedEmail`, `ConversionResult`).               |

Flow: `index.ts` → `cli.run()` → for each file `parseMsgFile()` → `buildMarkdown()`
→ write `output/<name>.md`. Parsing failures are caught per file so one bad file
never aborts the batch.

## File tree

```
msgmd/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
├── src/
│   ├── index.ts          # CLI entry point (bin)
│   ├── cli.ts            # file discovery, orchestration, summary report
│   ├── parser.ts         # .msg -> ParsedEmail
│   ├── markdown.ts       # ParsedEmail -> Markdown (+ HTML/plain-text rendering)
│   ├── types.ts          # shared types
│   └── markdown.test.ts  # unit test (node:test)
└── output/               # generated .md files (created at runtime, git-ignored)
```

## Setup

Requires Node.js >= 18.18.

```bash
npm install
```

## Usage

Run directly from TypeScript (no build step) using the `start` script:

```bash
# Convert a single file
npm start -- ./emails/mesaj.msg

# Convert every .msg in a folder
npm start -- ./emails
```

Everything after `--` is passed to the CLI.

Or build once and run the compiled output:

```bash
npm run build
node dist/index.js ./emails

# Optionally install it globally as the `msgmd` command:
npm link
msgmd ./emails
```

Converted files are written to `./output/`. If two source files share a base name,
the second is written as `name-1.md`, `name-2.md`, and so on.

### Example command

```bash
npm start -- ./emails
```

Example output:

```
✓ mesaj.msg -> mesaj.md
✗ bozuk.msg skipped: Unsupported file type!

──────── Summary ────────
Total files : 2
Converted   : 1
Skipped     : 1
Output dir  : /path/to/msgmd/output

Skipped files:
  - bozuk.msg: Unsupported file type!
```

### Example generated Markdown

```markdown
# Toplantı Notları

## Details

- **From:** Ayşe Yılmaz <ayse@example.com>
- **To:** Mehmet Kılıç <mehmet@example.com>
- **Cc:** cc@example.com
- **Date:** 2026-06-29T08:30:00.000Z

## Attachments

- rapor.pdf
- sunum.pptx

## Body

Merhaba,

Görüşmek üzere.

- Madde bir
- Madde iki
```

## Testing

```bash
npm test
```

Uses the built-in Node test runner (`node:test`) via `tsx`. The test covers the
Markdown builder (headings, metadata bullets, attachment list, Turkish characters)
and the HTML → Markdown conversion.

## Notes & limitations

- Bcc recipients are intentionally omitted from the rendered output.
- Attachment **binaries** are not extracted — only the file names are listed.
- HTML bodies are converted with `turndown`; highly complex HTML (deeply nested
  tables, inline styling) is simplified to readable Markdown rather than reproduced
  exactly.

## License

MIT
