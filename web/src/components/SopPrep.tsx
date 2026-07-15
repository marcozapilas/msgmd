import type { Conversion } from "../lib/types.ts";
import {
  IconChevron,
  IconLayers,
  IconMail,
  IconRefresh,
  IconSparkle,
  IconSpinner,
} from "./icons.tsx";

type LibraryLoadState = "idle" | "loading" | "complete" | "error";

interface Props {
  sources: Conversion[];
  /** Total selected IDs — may exceed sources.length while the Library loads. */
  selectedCount: number;
  loadState: LibraryLoadState;
  onRetry: () => void;
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
export function SopPrep({ sources, selectedCount, loadState, onRetry, onBack }: Props) {
  const resolvedCount = sources.length;
  const unresolved = resolvedCount < selectedCount;
  // M2 will gate drafting on exactly this condition; the stub stays disabled.
  const canDraft =
    loadState === "complete" && !unresolved && selectedCount > 0;

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
            <div className="stat-num">
              {unresolved ? `${resolvedCount} of ${selectedCount}` : resolvedCount}
            </div>
            <div className="stat-lbl">
              {unresolved
                ? "selected sources resolved so far"
                : `source email${resolvedCount === 1 ? "" : "s"} selected`}
            </div>
          </div>
        </div>

        {unresolved &&
          (loadState === "error" ? (
            <div className="resolve-error" role="alert">
              Some selected sources could not be resolved because the Library
              did not finish loading. Nothing was removed from your selection.
              <button className="btn-subtle btn-sm" type="button" onClick={onRetry}>
                <IconRefresh size={14} /> Retry Library load
              </button>
            </div>
          ) : (
            <div className="resolve-note" role="status" aria-live="polite">
              <IconSpinner size={15} />
              Resolving selected sources… ({resolvedCount} of {selectedCount}{" "}
              loaded)
            </div>
          ))}

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
          {/* Stub: always disabled in M1.x. canDraft carries the exact
              readiness semantics M2 will attach real drafting to. */}
          <button
            className="btn-primary"
            type="button"
            disabled
            title={
              canDraft
                ? "Drafting arrives in the next step"
                : "Waiting for all selected sources to resolve"
            }
          >
            <IconSparkle size={15} /> Draft SOP — coming next
          </button>
        </div>
      </section>
    </div>
  );
}
