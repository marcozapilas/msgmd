import { createPortal } from "react-dom";
import { IconEye, IconSparkle, IconX } from "./icons.tsx";

interface Props {
  count: number;
  onReview: () => void;
  onClear: () => void;
  onExit: () => void;
  onCreateSop: () => void;
}

/**
 * Fixed bottom bar shown while at least one email is selected. Rendered
 * through a portal so ancestor styling can't offset it; the Library adds a
 * spacer so it never covers the last rows or controls.
 */
export function SelectionBar({ count, onReview, onClear, onExit, onCreateSop }: Props) {
  if (count === 0) return null;
  return createPortal(
    <div className="selbar" role="toolbar" aria-label="Selected emails">
      <span className="selbar-count">
        <b>{count}</b> selected
      </span>
      <div className="selbar-actions">
        <button className="btn-subtle btn-sm" type="button" onClick={onReview}>
          <IconEye size={15} /> Review
        </button>
        <button className="btn-subtle btn-sm" type="button" onClick={onClear}>
          Clear selection
        </button>
        <button
          className="icon-btn"
          type="button"
          onClick={onExit}
          title="Exit selection mode"
          aria-label="Exit selection mode"
        >
          <IconX size={16} />
        </button>
        <button className="btn-primary btn-sm" type="button" onClick={onCreateSop}>
          <IconSparkle size={15} /> Create SOP ({count})
        </button>
      </div>
    </div>,
    document.body,
  );
}
