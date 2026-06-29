# msgmd

Convert Outlook `.msg` files into clean, readable Markdown.

This repo ships **two front-ends over one shared conversion core**:

1. **CLI** (`src/`) — a local Node.js tool for batch-converting files on disk.
2. **Web app** (`web/` + `supabase/`) — a React app on Netlify with Supabase
   Auth, Storage and an Edge Function that does the conversion server-side.

Both extract subject, from, to, cc, date and attachment names, render the body
(HTML → Markdown, or plain-text paragraphs/lists), and preserve Turkish
characters (ç, ğ, ı, İ, ö, ş, ü) via UTF-8.

---

## Repository layout

```
msgmd/
├── src/
│   ├── core/
│   │   ├── converter.ts        # SHARED core: parse .msg + build Markdown
│   │   └── converter.test.ts   # unit test (node:test)
│   ├── cli.ts                  # CLI: file discovery, batch, summary report
│   └── index.ts                # CLI bin entry
├── web/                        # React + Vite + TS frontend (deploy to Netlify)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/         # Auth, Uploader, ConversionList
│   │   └── lib/                # supabase client, types
│   ├── netlify.toml
│   └── .env.example
├── supabase/
│   ├── migrations/0001_init.sql        # tables, RLS, storage buckets + policies
│   ├── functions/convert-msg/index.ts  # Deno Edge Function
│   ├── functions/import_map.json
│   └── config.toml
├── package.json                # CLI package
└── tsconfig.json
```

### One conversion core, two runtimes

`src/core/converter.ts` is intentionally a **single file with no relative
imports and no Node-only APIs** (no `fs`, no `Buffer`). That lets the exact same
source be consumed by:

- the **Node CLI**, importing it as `./core/converter.js`, and
- the **Deno Edge Function**, importing it as `../../../src/core/converter.ts`
  (npm deps resolved via `supabase/functions/import_map.json`).

So there is a single source of truth for parsing and Markdown generation.

---

## Web app architecture

```
Browser (React/Vite on Netlify)
   │  1. sign in (Supabase Auth)
   │  2. upload each .msg  ───────────────►  Supabase Storage  (msg-uploads/<uid>/<id>.msg)
   │  3. insert row        ───────────────►  Postgres `conversions` (status=pending)
   │  4. invoke function   ───────────────►  Edge Function `convert-msg`
   │                                              │ downloads .msg (user JWT, RLS)
   │                                              │ convertMsgToMarkdown()
   │                                              │ uploads .md to md-outputs/
   │                                              │ updates row (status=done, markdown)
   │  5. list + preview + download/ZIP  ◄──────── Postgres `conversions`
```

- **Security:** every bucket and table is private with row-level security. The
  Edge Function runs with the **caller's JWT** (not the service role), so a user
  can only ever read/write rows and storage objects under their own `user_id`.
- **Batch upload:** multiple `.msg` files are processed in parallel; one
  corrupted file is marked `error` without blocking the rest.

---

## CLI usage

Requires Node.js >= 18.18.

```bash
npm install

# Convert a single file or a whole folder (output written to ./output/)
npm start -- ./emails/mesaj.msg
npm start -- ./emails

# Or build and run the compiled bin
npm run build
node dist/index.js ./emails

npm test        # run unit tests
```

Example run:

```
✓ ornek.msg -> ornek.md
✗ bozuk.msg skipped: Unsupported file type!

──────── Summary ────────
Total files : 2
Converted   : 1
Skipped     : 1
Output dir  : /path/to/msgmd/output
```

---

## Web app setup

### 1. Supabase (you provision the project)

```bash
# Install the CLI once: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>

# Apply schema: conversions table, RLS, and the two private storage buckets
supabase db push        # applies supabase/migrations/0001_init.sql

# Deploy the Edge Function (verify_jwt + import_map come from config.toml)
supabase functions deploy convert-msg
```

> The migration creates the `msg-uploads` and `md-outputs` buckets and their
> per-user RLS policies, plus the `conversions` table. No service-role key is
> needed anywhere — the function uses the signed-in user's token.

Enable the auth methods you want under **Authentication → Providers** (email
password and/or magic link are used by the UI out of the box).

### 2. Frontend (local dev)

```bash
cd web
npm install
cp .env.example .env.local      # then fill in your project's URL + anon key
npm run dev                     # http://localhost:5173
```

`.env.local`:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

### 3. Netlify deploy (you provision the site)

`web/netlify.toml` is preconfigured (base `web/`, build `npm run build`,
publish `dist`, SPA redirect). In the Netlify UI:

1. Connect the repo, set **Base directory** to `web`.
2. Add environment variables **`VITE_SUPABASE_URL`** and
   **`VITE_SUPABASE_ANON_KEY`**.
3. Add your Netlify site URL to Supabase **Authentication → URL Configuration**
   (Site URL + Redirect URLs) so magic-link / email confirmations redirect back.

Deploy. Done.

---

## What gets extracted

| Field        | Source (MAPI)                                  |
| ------------ | ---------------------------------------------- |
| Subject      | `PidTagSubject`                                |
| From         | sender name + SMTP address                     |
| To / Cc      | recipients by `recipType` (Bcc omitted)        |
| Date         | delivery/submit time, else `Date:` header      |
| Attachments  | file **names** (binaries are not extracted)    |
| Body         | HTML body → Markdown, else plain text          |

## Notes & limitations

- Attachment binaries are not extracted — only names are listed.
- Highly complex HTML (deeply nested tables, inline styling) is simplified to
  readable Markdown rather than reproduced pixel-for-pixel.
- Bcc recipients are intentionally omitted from output.

## License

MIT
