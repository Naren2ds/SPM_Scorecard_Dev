export function ScoringConfigHeading() {
  return (
    <div className="scoring-config-heading">
      <strong>KPI Scoring Configuration</strong>
      <span>Max Score is fixed. Preview changes to the floor or target before applying.</span>
    </div>
  );
}

export function FixedMaxScore({ value }: { value: number }) {
  return (
    <label>
      <span>Max Score (Fixed)</span>
      <input
        className="fixed-config-value"
        type="text"
        value={Number.isFinite(value) ? value : ""}
        readOnly
        aria-readonly="true"
      />
    </label>
  );
}
