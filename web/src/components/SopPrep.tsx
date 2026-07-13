import type { Conversion } from "../lib/types.ts";
import { IconChevron, IconLayers, IconMail, IconSparkle } from "./icons.tsx";

interface Props {
  sources: Conversion[];
  onBack: () => void;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/**
 * M1 stub: receives the selected emails through in-memory state only.
 * Creates no database record and calls no AI — drafting arrives in a later
 * milestone. Selection is preserved when going back to the Library.
 */
export function SopPrep({ sources, onBack }: Props) {
  return (
    <div className="view">
      <header className="view-head">
        <h1 className="view-title">Create SOP</h1>
        <p className="view-sub">
          Your selected emails are ready. SOP drafting will be enabled in the
          next step.
        </p>
      </header>

      <section className="card pad">
        <div className="sop-summary">
          <span className="stat-ic">
            <IconLayers size={18} />
          </span>
          <div>
            <div className="stat-num">{sources.length}</div>
            <div className="stat-lbl">
              source email{sources.length === 1 ? "" : "s"} selected
            </div>
          </div>
        </div>

        {sources.length > 0 && (
          <ul className="sop-sources">
            {sources.map((c) => (
              <li key={c.id} className="sop-source">
                <span className="q-ic done">
                  <IconMail size={15} />
                </span>
                <div className="row-main">
                  <div className="row-name">{c.subject || c.source_name}</div>
                  <div className="row-meta">
                    <span>{c.sender_name || c.sender_email || "Unknown sender"}</span>
                    <span>{fmtDate(c.sent_at)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="sop-actions">
          <button className="btn-ghost" type="button" onClick={onBack}>
            <span className="flip-x">
              <IconChevron size={15} />
            </span>
            Back to Library
          </button>
          <button className="btn-primary" type="button" disabled>
            <IconSparkle size={15} /> Draft SOP — coming next
          </button>
        </div>
      </section>
    </div>
  );
}
