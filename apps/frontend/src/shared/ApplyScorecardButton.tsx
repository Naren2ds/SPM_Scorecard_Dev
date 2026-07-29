// ---------------------------------------------------------------------------
// ApplyScorecardButton — syncs a KPI page's current floor / target / maxScore
// to the backend KPI_CONFIGS and triggers a scorecard cache rebuild.
// ---------------------------------------------------------------------------

import { useState } from "react";

interface ApplyScorecardButtonProps {
  kpiId: string;           // e.g. "DOT", "SA", "SM" …
  floor: number | null;
  target: number | null;
  maxScore: number;
  apiBase: string;
}

export function ApplyScorecardButton({
  kpiId,
  floor,
  target,
  maxScore,
  apiBase,
}: ApplyScorecardButtonProps) {
  const [status, setStatus] = useState<"idle" | "applying" | "done" | "error">("idle");

  const handleApply = async () => {
    setStatus("applying");
    try {
      const res = await fetch(`${apiBase}/api/scorecard/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpiId, floor, target, maxScore }),
      });
      if (!res.ok) throw new Error("Server returned an error");
      setStatus("done");
      setTimeout(() => setStatus("idle"), 3500);
    } catch {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3500);
    }
  };

  return (
    <div className="apply-scorecard-wrap">
      <button
        type="button"
        className="apply-scorecard-btn"
        onClick={handleApply}
        disabled={status === "applying"}
        title="Persist this KPI's floor, target, and max score to the Normalized Scorecard and rebuild the cache."
      >
        {status === "applying" ? "Applying…" : "Apply to Scorecard"}
      </button>
      {status === "done"  && <span className="apply-scorecard-status apply-ok">✓ Scorecard updated</span>}
      {status === "error" && <span className="apply-scorecard-status apply-err">✗ Failed — check server</span>}
    </div>
  );
}
