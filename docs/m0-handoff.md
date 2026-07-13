# M0 Handoff — Structured Email Metadata Backfill

Status: **ACCEPTED** (database phase) — executed against production
`jtksejeqwtzcwzzahgwx` in a maintenance window.

## What M0 did

Added four structured metadata columns to `public.conversions` and backfilled
them for all historical rows by deterministically parsing the app's own
generated `## Details` block. `conversions.markdown` is **immutable source
data**: no M0 statement ever rewrites, normalizes, or unescapes stored
markdown; all parsing happens in flight.

| Column | Source | Notes |
|---|---|---|
| `sender_name` | `- **From:**` line | unescaped display name |
| `sender_email` | `- **From:**` line | only when the address contains `@`; X.500 DNs are never stored as email |
| `sent_at` | `- **Date:**` line | strict ISO-8601 only |
| `recipients` | `- **To:** / - **Cc:**` lines | `{to:[], cc:[], ambiguous?}`; never NULL for done rows |

Artifacts (exact SQL executed):
- `supabase/migrations/0004_email_metadata.sql`
- `supabase/backfill/m0_backfill.sql` (rev. 4)
- `supabase/backfill/m0_script_b_samples.sql`

## Dry-run report (pre-execution, read-only)

```
total_rows=6710  done_with_md=6708
from_line_found=6708  from_unknown=0  from_with_email=5184
date_line_found=6708  date_unknown=0  date_iso=6708
to_line_found=6708  to_none=140  to_parse_success=1085  to_ambiguous=5483
cc_line_found=3249  cc_ambiguous=3193
```

The large `to_ambiguous`/`cc_ambiguous` counts were diagnosed as **Exchange
X.500 legacy DN addresses** (`Name </o=ExchangeLabs/...>`), not genuine
ambiguity; the parser was generalized accordingly (bracketed address without
`@` → name kept, email NULL) before execution.

## Post-backfill reconciliation (single REPEATABLE READ transaction)

| metric | value | expectation | result |
|---|---|---|---|
| eligible_rows_before | 6708 | ≈6708 | ✅ |
| rows_updated_metadata (actual) | 6708 | = eligible | ✅ |
| sender_name_populated | 6708 | high | ✅ |
| sender_email_populated | 5184 | = dry-run `from_with_email` | ✅ exact |
| sent_at_populated | 6708 | all | ✅ |
| recipients_populated | 6708 | all (guaranteed) | ✅ |
| missing_sender_name | 0 | small | ✅ |
| missing_sender_email | 1524 | ≈6708−5184 (DN/name-only senders; legitimate NULLs) | ✅ exact |
| missing_sent_at | 0 | 0 | ✅ |
| missing_recipients | 0 | 0 (guaranteed) | ✅ |
| recipients_ambiguous | 3 | ≈0 | ⚠️ accepted, see below |

`rows_updated_metadata (actual)` is derived from `GET DIAGNOSTICS ROW_COUNT`
with an UPDATE predicate that fires only when at least one persisted field
actually changes; reruns are no-ops for rows whose remaining NULLs are
legitimate.

## Baseline data-quality exceptions (accepted)

### B3 — ambiguous recipient rows (3 of 6708, 0.045%)

These rows' To/Cc lines could not be split deterministically; their entries
were preserved via the raw-name fallback (`{"name": "<raw>", "email": null}`)
and flagged with `"ambiguous": true` in the `recipients` payload. They are
queryable at any time with:

```sql
select id, source_name, recipients from public.conversions
where recipients->>'ambiguous' = 'true';
```

All three are undeliverable-report ("Teslim edilmez" / NDR) messages, whose
To lines carry a bare comma-separated display-name list with no addresses at
all — the one shape that cannot be split deterministically. The fallback
behaved exactly as designed: names retained verbatim in a single entry, no
email fabricated, `ambiguous: true` set. **These are documented safe fallback
cases, not failures.**

| id | source_name | to_line | resulting recipients JSONB |
|---|---|---|---|
| `cf6d9e02-10e8-497b-82ec-7a2e9067e86c` | Teslim edilmez_ RE_ Balance Confirmation – Homend UK Audit (Rhenus Logistics Ltd_).msg | `Ferdi Hilgers, Ipek Gurkan` | `{"cc":[],"to":[{"name":"Ferdi Hilgers, Ipek Gurkan","email":null}],"ambiguous":true}` |
| `92481b48-db97-45e2-9df1-7dc5270c0b45` | Teslim edilmez_ RE_ Karaca UK-DEU Homend Products Sellout Hk_ (40).msg | `İsmail PİŞKİN, Hakan DURAN, Ayça Yağışan UTKU, Ömer Barbaros YİŞ` | `{"cc":[],"to":[{"name":"İsmail PİŞKİN, Hakan DURAN, Ayça Yağışan UTKU, Ömer Barbaros YİŞ","email":null}],"ambiguous":true}` |
| `f46f2b58-fa4a-4004-8fd3-0faccc3361f5` | Teslim edilmez_ RE_ Karaca UK-DEU Homend Products Sellout Hk_.msg | `Hakan KOÇER, Harun KUTLUAY` | `{"cc":[],"to":[{"name":"Hakan KOÇER, Harun KUTLUAY","email":null}],"ambiguous":true}` |

### Legitimate NULL `sender_email` (1524 rows)

Senders recorded by Exchange as X.500 DNs or display-name-only. `sender_name`
is populated for all of them; the original value remains in the immutable
markdown. Future conversions reduce this class via the SMTP-preference
converter change (below).

## B4 spot-check (5 random rows)

Verified side-by-side: markdown `From/To/Cc/Date` lines match the structured
columns exactly, including mixed DN+SMTP recipient lists (DN → email NULL,
SMTP kept) and Turkish characters preserved.

## Converter change shipped with M0

New conversions now prefer the recipient's SMTP address (`PidTagSmtpAddress`)
over `PidTagEmailAddress` (which carries an X.500 DN for internal Exchange
recipients), in both the web converter and the CLI core. Verified by harness:

- files without an SMTP field produce **byte-identical** markdown to before;
- files with it now emit real addresses in To/Cc (better markdown *and*
  metadata);
- new output remains parseable by the M0 parser;
- the structured payload written by the Uploader (same `@`-guard rules as the
  backfill) can never contradict the generated markdown.

## Migration-history synchronization

This project's established schema workflow is **manual application via the
Supabase Dashboard SQL Editor**, with `supabase/migrations/*.sql` as the
canonical, ordered record. The Supabase CLI has never been linked to this
project, so there is no CLI-tracked history to repair, and 0001–0004 were all
applied manually in order. The column-addition migration was **not** rerun to
"fix" history.

Verification (read-only) — confirms no divergent CLI history exists:

```sql
select to_regclass('supabase_migrations.schema_migrations') as cli_history_table;
-- expected: NULL (no CLI history). If non-NULL, list it:
-- select * from supabase_migrations.schema_migrations order by version;
```

If the project adopts the Supabase CLI later, synchronize without touching the
schema using either:

```
supabase db pull                # capture remote state as a baseline, or
supabase migration repair --status applied 0001 0002 0003 0004
```

## Rollback

The four columns are read by nothing before M1 UI work lands. Full rollback:

```sql
alter table public.conversions
  drop column sender_name, drop column sender_email,
  drop column sent_at, drop column recipients;
drop index if exists conversions_user_sent_idx;
```

## RLS / grants

No changes required or made: policies are row-level and table-level grants
cover the new columns automatically.
