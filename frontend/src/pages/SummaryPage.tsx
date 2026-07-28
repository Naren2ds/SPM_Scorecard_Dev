// ---------------------------------------------------------------------------
// SummaryPage — Scoring Methodology & Formula Reference
// ---------------------------------------------------------------------------

const KPI_BUDGET = [
  { kpi: "DOT (Delivery On Time)", pillar: "Operational", input: "On-Time PO Lines / Adjusted Denominator", floor: "70%", target: "85%", max: 15 },
  { kpi: "IOT (Invoice On Time)", pillar: "Operational", input: "Invoice On-Time Count / Total PO Lines", floor: "70%", target: "85%", max: 15 },
  { kpi: "Invoice Conformity", pillar: "Operational", input: "1 \u2212 (Missing PO + Wrong PO + Wrong Invoice) / Total Invoices", floor: "70%", target: "85%", max: 15 },
  { kpi: "Price Divergence", pillar: "Operational", input: "ABS(Invoice Value \u2212 PO Value) / PO Value (lower = better)", floor: "15%", target: "5%", max: 10 },
  { kpi: "Supplier Assessment", pillar: "Quality", input: "Green / Yellow / Red rating counts \u2192 Health Index", floor: "50%", target: "80%", max: 10 },
  { kpi: "Supplier Compliance %", pillar: "Quality", input: "Completed Docs / Required Docs", floor: "60%", target: "90%", max: 10 },
  { kpi: "CO\u2082 Reduction Potential", pillar: "Sustainability", input: "Absolute tCO\u2082e value (higher = better)", floor: "Q1 / manual", target: "Q3 / manual", max: 10 },
  { kpi: "Supplier Maturity Score", pillar: "Sustainability", input: "0\u2013100 maturity score", floor: "40", target: "80", max: 10 },
  { kpi: "Eclipse Score", pillar: "Sustainability", input: "0\u2013100 combined pillar score (CA + Engagement + Reporting)", floor: "50", target: "80", max: 5 },
];

const PERCENTILE_EXAMPLE = [
  { supplier: "Supplier A", dot: "95%", rank: 1, p: "100%" },
  { supplier: "Supplier B", dot: "88%", rank: 2, p: "75%" },
  { supplier: "Supplier C", dot: "82%", rank: 3, p: "50%" },
  { supplier: "Supplier D", dot: "75%", rank: 4, p: "25%" },
  { supplier: "Supplier E", dot: "71%", rank: 5, p: "0%" },
];

const WRONG_FORMULA_EXAMPLE = [
  { supplier: "Supplier A (best)", dot: "95%", rank: 1, wrong: "100%", right: "100%" },
  { supplier: "Supplier B", dot: "88%", rank: 2, wrong: "80%", right: "75%" },
  { supplier: "Supplier C", dot: "82%", rank: 3, wrong: "60%", right: "50%" },
  { supplier: "Supplier D", dot: "75%", rank: 4, wrong: "40%", right: "25%" },
  { supplier: "Supplier E (worst)", dot: "71%", rank: 5, wrong: "20% ❌", right: "0% ✓" },
];

const COHORT_EXAMPLE = [
  {
    label: "Supplier X",
    dot: "88%",
    cohort: "Weak cohort (all ~70–75%)",
    rank: "1st of 5",
    percentile: "100%",
    strict: "15 × 1.00 × 1.00 = 15.00",
    soft: "15 × 1.00 × (0.70 + 0.30×1.00) = 15.00",
  },
  {
    label: "Supplier Y",
    dot: "88%",
    cohort: "Strong cohort (all ~85–95%)",
    rank: "5th of 5",
    percentile: "0%",
    strict: "15 × 0.00 × 1.00 = 0.00 ❌",
    soft: "15 × 1.00 × (0.70 + 0.30×0.00) = 10.50 ✓",
  },
];

const EDGE_CASES = [
  { situation: "Only 1 supplier in cohort", rule: "Percentile = 100%. No peers to compare against — full relative credit by rule." },
  { situation: "All suppliers have identical value, value ≥ Target", rule: "Percentile = 100%. Everyone meets the bar, no differentiation needed." },
  { situation: "All suppliers have identical value, value < Target", rule: "Percentile = 50%. No variance — everyone gets half percentile credit as a neutral signal." },
  { situation: "Two or more suppliers tie", rule: "Average rank used: Rank = (startRank + endRank) / 2. Both get the same percentile." },
  { situation: "Value below Critical Floor", rule: "Attainment = 0. Earned Score = 0 regardless of percentile." },
  { situation: "Value missing / blank", rule: "Missing Data — excluded from ranking and scoring. Not treated as zero." },
  { situation: "KPI marked Not Applicable", rule: "Excluded from all cohort ranking and rollups. Earned Score = null." },
];

export default function SummaryPage() {
  return (
    <div className="summary-page">

      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="summary-hero">
        <p className="eyebrow">Methodology Reference</p>
        <h1>Supplier Scorecard — How Scores Are Calculated</h1>
        <p className="summary-lead">
          Every KPI in this scorecard follows the same three-step formula:
        </p>
        <ol className="summary-lead-list">
          <li>Normalize the raw value into an <strong>Attainment</strong> factor — how well did the supplier perform against the floor and target?</li>
          <li>Rank peers into a <strong>Percentile</strong> — where does the supplier sit relative to their cohort?</li>
          <li>Combine both into an <strong>Earned Score</strong> using either Soft Stretch or Strict mode.</li>
        </ol>
        <p className="summary-lead">
          This page explains why each step exists, what would go wrong without it, and how the numbers are produced.
        </p>
        <nav className="guide-actions" aria-label="Guide shortcuts">
          <a href="#scorecard-budget">Explore the scorecard</a>
          <a href="#scoring-method">See how scoring works</a>
          <a href="#formula-reference">Formula reference</a>
        </nav>
        <div className="guide-overview" aria-label="Scoring overview">
          <article>
            <span>01</span>
            <strong>Measure attainment</strong>
            <p>Compare actual supplier performance against the critical floor and business target.</p>
          </article>
          <article>
            <span>02</span>
            <strong>Benchmark peers</strong>
            <p>Rank suppliers fairly within their applicable category, market, and reporting cohort.</p>
          </article>
          <article>
            <span>03</span>
            <strong>Calculate score</strong>
            <p>Combine absolute delivery with relative performance into a transparent earned score.</p>
          </article>
        </div>
      </section>

      {/* ── Score Budget ─────────────────────────────────── */}
      <details className="summary-section" open>
        <summary id="scorecard-budget" className="summary-section-summary">1 — Scorecard Budget</summary>
        <p className="summary-body">
          Each KPI is assigned a maximum score that reflects its strategic weight in the
          overall supplier evaluation. Operational delivery (DOT) carries the highest weight,
          followed by quality and sustainability pillars. A supplier's total scorecard is the
          sum of earned scores across all applicable KPIs.
        </p>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>KPI</th>
                <th>Pillar</th>
                <th>Input Value</th>
                <th>Critical Floor</th>
                <th>Target</th>
                <th>Max Score</th>
              </tr>
            </thead>
            <tbody>
              {KPI_BUDGET.map((row) => (
                <tr key={row.kpi}>
                  <td><strong>{row.kpi}</strong></td>
                  <td>
                    <span className={`summary-pillar-badge summary-pillar-${row.pillar.toLowerCase()}`}>
                      {row.pillar}
                    </span>
                  </td>
                  <td>{row.input}</td>
                  <td>{row.floor}</td>
                  <td>{row.target}</td>
                  <td className="summary-center"><strong>{row.max}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* ── Universal Formula ────────────────────────────── */}
      <details className="summary-section" open>
        <summary id="scoring-method" className="summary-section-summary">2 — The Universal Earned Score Formula</summary>
        <p className="summary-body">
          All nine KPIs use the same formula structure. Only the input value and
          the max score differ between them. Price Divergence uses an inverted attainment
          (lower divergence = better).
        </p>
        <div className="summary-formula-steps">
          <div className="summary-step">
            <span className="summary-step-num">Step 1</span>
            <div>
              <strong>Normalize Value</strong>
              <ul className="summary-step-list">
                <li><strong>DOT</strong> — On-Time PO Lines divided by adjusted denominator → 0–1 ratio</li>
                <li><strong>IOT</strong> — Invoice On-Time Count divided by Total PO Lines → 0–1 ratio</li>
                <li><strong>Invoice Conformity</strong> — 1 − (Missing PO + Wrong PO + Wrong Invoice) / Total Invoices → 0–1 ratio</li>
                <li><strong>Price Divergence</strong> — ABS(Invoice Value − PO Value) / PO Value → 0–1 ratio (inverted: lower = better)</li>
                <li><strong>Supplier Assessment</strong> — Green / Yellow / Red ratings → Health Index (0–1)</li>
                <li><strong>Compliance %</strong> — Completed Docs divided by Required Docs → 0–100%</li>
                <li><strong>CO₂ Reduction Potential</strong> — Absolute tCO₂e value, used as-is (≥ 0)</li>
                <li><strong>Supplier Maturity &amp; Eclipse</strong> — 0–1 decimal × 100; 1–100 used as-is</li>
              </ul>
            </div>
          </div>
          <div className="summary-step-arrow">↓</div>
          <div className="summary-step">
            <span className="summary-step-num">Step 2</span>
            <div>
              <strong>Attainment = (Value − Critical Floor) / (Target − Critical Floor), clamped 0–1</strong>
              <p>Measures absolute performance. Below floor = 0. At or above target = 1. Between them = proportional 0→1. This is the "did you actually perform well?" gate.</p>
            </div>
          </div>
          <div className="summary-step-arrow">↓</div>
          <div className="summary-step">
            <span className="summary-step-num">Step 3</span>
            <div>
              <strong>Percentile = (N − Rank) / (N − 1)</strong>
              <p>Measures relative performance within the cohort. Best supplier = 100%, worst = 0%. This is the "how do you compare to peers?" signal.</p>
            </div>
          </div>
          <div className="summary-step-arrow">↓</div>
          <div className="summary-step summary-step-final">
            <span className="summary-step-num">Step 4</span>
            <div>
              <ul className="summary-step-list">
                <li>
                  <strong>Soft Stretch (default)</strong>
                  <p className="summary-formula-display">Max Score &times; Attainment &times; (0.70 + 0.30 &times; Percentile)</p>
                </li>
                <li>
                  <strong>Strict</strong>
                  <p className="summary-formula-display">Max Score &times; Percentile &times; Attainment</p>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </details>

      {/* ── Attainment ───────────────────────────────────── */}
      <details className="summary-section" open>
        <summary className="summary-section-summary">3 — Why Attainment? The Absolute Performance Gate</summary>
        <p className="summary-body">
          Percentile alone would let a supplier score well just by being the best in a weak
          group — even if their absolute performance is far below what the business needs.
          Attainment is the gate that prevents this.
        </p>

        <h3 className="summary-subhead">The problem without Attainment</h3>
        <p className="summary-body">
          Imagine 5 suppliers all delivering between 40–55% DOT — far below the 70% floor.
          Without Attainment, the best of them (55%) would rank 1st and earn a high score
          purely from percentile. That is not a valid signal of good performance.
        </p>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Supplier</th><th>DOT%</th><th>Rank</th><th>Percentile</th>
                <th>Without Attainment (Max × P)</th>
                <th>With Attainment (gate = 0 below floor)</th>
              </tr>
            </thead>
            <tbody>
              {[
                { s: "A (best)",  dot: "55%", r: 1, p: "100%", without: "15 × 1.00 = 15.00 ❌", with: "Attainment = 0 → 0.00 ✓" },
                { s: "B",         dot: "50%", r: 2, p: "75%",  without: "15 × 0.75 = 11.25 ❌", with: "Attainment = 0 → 0.00 ✓" },
                { s: "C",         dot: "47%", r: 3, p: "50%",  without: "15 × 0.50 = 7.50 ❌",  with: "Attainment = 0 → 0.00 ✓" },
                { s: "D",         dot: "43%", r: 4, p: "25%",  without: "15 × 0.25 = 3.75 ❌",  with: "Attainment = 0 → 0.00 ✓" },
                { s: "E (worst)", dot: "40%", r: 5, p: "0%",   without: "15 × 0.00 = 0.00",     with: "Attainment = 0 → 0.00 ✓" },
              ].map((r) => (
                <tr key={r.s}>
                  <td>{r.s}</td><td>{r.dot}</td><td>{r.r}</td><td>{r.p}</td>
                  <td className={r.without.includes("❌") ? "summary-wrong" : ""}>{r.without}</td>
                  <td className="summary-correct">{r.with}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="summary-callout summary-callout-warning">
          <strong>Without Attainment:</strong> Supplier A earns 15 points for 55% DOT —
          well below the 70% floor. Attainment sets this to zero because the business
          requirement is not met, regardless of how they rank among peers.
        </div>

        <h3 className="summary-subhead">How Attainment works</h3>
        <div className="summary-split">
          <div className="summary-split-card">
            <strong>Below Critical Floor</strong>
            <p>Attainment = 0. Earned Score = 0. The supplier has not met the minimum
            business requirement. Percentile is irrelevant.</p>
          </div>
          <div className="summary-split-card">
            <strong>Between Floor and Target</strong>
            <p>Attainment scales linearly from 0 → 1.
            A supplier halfway between floor and target gets Attainment = 0.5.</p>
          </div>
          <div className="summary-split-card">
            <strong>At or Above Target</strong>
            <p>Attainment = 1.0 (full credit). Exceeding the target does not add
            extra attainment — the full score range is then determined by percentile.</p>
          </div>
        </div>

        <h3 className="summary-subhead">Worked example — Floor 70%, Target 85%</h3>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr><th>DOT%</th><th>Calculation</th><th>Attainment</th></tr>
            </thead>
            <tbody>
              {[
                { dot: "60%", calc: "Below floor (60% < 70%)", att: "0.0000" },
                { dot: "70%", calc: "(70% − 70%) / (85% − 70%) = 0 / 15%", att: "0.0000" },
                { dot: "77.5%", calc: "(77.5% − 70%) / (85% − 70%) = 7.5% / 15%", att: "0.5000" },
                { dot: "85%", calc: "(85% − 70%) / (85% − 70%) = 15% / 15%", att: "1.0000" },
                { dot: "95%", calc: "Above target — clamped at 1", att: "1.0000" },
              ].map((r) => (
                <tr key={r.dot}>
                  <td><strong>{r.dot}</strong></td>
                  <td>{r.calc}</td>
                  <td><strong>{r.att}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="summary-callout">
          <strong>Why a floor and a target, not just one threshold?</strong> A single
          threshold (pass/fail) hides the difference between 71% and 84% DOT — both
          would score the same. The floor–target range converts performance into a
          continuous 0–1 scale, making every percentage point of improvement visible
          in the earned score.
        </div>
      </details>

      {/* ── Percentile ───────────────────────────────────── */}
      <details className="summary-section" open>
        <summary className="summary-section-summary">4 — Why (N − Rank) / (N − 1) for Percentile?</summary>
        <p className="summary-body">
          There is a simpler-looking formula often used in textbooks:{" "}
          <strong>P = (n / N) × 100</strong> — "what percentage of the group scored
          below you?" This is correct for standardised testing, but it has a critical
          flaw for supplier scoring.
        </p>

        <h3 className="summary-subhead">The flaw in n/N — the worst supplier never reaches 0%</h3>
        <p className="summary-body">
          With 5 suppliers, the worst-ranked supplier would get 1/5 = <strong>20%
          percentile</strong> — not zero. As the cohort grows, this floor shrinks but
          never disappears. With 100 suppliers, the worst still gets 1%.
        </p>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>DOT%</th>
                <th>Rank</th>
                <th>n/N × 100 (wrong)</th>
                <th>(N−Rank)/(N−1) (correct)</th>
              </tr>
            </thead>
            <tbody>
              {WRONG_FORMULA_EXAMPLE.map((r) => (
                <tr key={r.supplier}>
                  <td>{r.supplier}</td>
                  <td>{r.dot}</td>
                  <td>{r.rank}</td>
                  <td className={r.wrong.includes("❌") ? "summary-wrong" : ""}>{r.wrong}</td>
                  <td className={r.right.includes("✓") ? "summary-correct" : ""}>{r.right}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="summary-callout">
          <strong>Why this matters in scoring:</strong> With n/N, the worst supplier in
          a cohort of 5 gets 20% percentile. In Strict mode that becomes{" "}
          <code>15 × 0.20 × Attainment</code> — a non-zero score just for showing up
          last. With (N−Rank)/(N−1), worst place = 0% — a clean, unambiguous signal.
        </div>

        <h3 className="summary-subhead">Worked example — 5 suppliers, N=5</h3>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>DOT%</th>
                <th>Rank</th>
                <th>Formula: (5−Rank)/(5−1)</th>
                <th>Percentile</th>
              </tr>
            </thead>
            <tbody>
              {PERCENTILE_EXAMPLE.map((r) => (
                <tr key={r.supplier}>
                  <td>{r.supplier}</td>
                  <td>{r.dot}</td>
                  <td>{r.rank}</td>
                  <td>({5 - r.rank}) / {4}</td>
                  <td><strong>{r.p}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="summary-body">
          The spread is perfectly even: each rank step is exactly 1/(N−1) = 25%.
          Best = 100%, worst = 0%. This holds for any cohort size.
        </p>
      </details>

      {/* ── Soft Stretch ─────────────────────────────────── */}
      <details className="summary-section" open>
        <summary className="summary-section-summary">5 — Why Soft Stretch: 0.70 + 0.30 × Percentile?</summary>
        <p className="summary-body">
          Strict mode multiplies Max × Percentile × Attainment. This creates a serious
          fairness problem when cohort composition varies.
        </p>

        <h3 className="summary-subhead">The cohort problem — same DOT, opposite scores</h3>
        <p className="summary-body">
          Two suppliers both deliver <strong>88% DOT</strong> (above the 85% target,
          Attainment = 1.0). The only difference is who they are benchmarked against.
        </p>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>DOT%</th>
                <th>Cohort</th>
                <th>Percentile</th>
                <th>Strict Score</th>
                <th>Soft Stretch Score</th>
              </tr>
            </thead>
            <tbody>
              {COHORT_EXAMPLE.map((r) => (
                <tr key={r.label}>
                  <td><strong>{r.label}</strong></td>
                  <td>{r.dot}</td>
                  <td>{r.cohort}</td>
                  <td>{r.percentile}</td>
                  <td className={r.strict.includes("❌") ? "summary-wrong" : "summary-correct"}>{r.strict}</td>
                  <td className={r.soft.includes("✓") ? "summary-correct" : ""}>{r.soft}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="summary-callout summary-callout-warning">
          <strong>Strict mode problem:</strong> Supplier Y delivers 88% DOT — above
          target — but scores <strong>0</strong> because they happened to be in a
          high-performing cohort. This is not a fair signal of their performance.
        </div>

        <h3 className="summary-subhead">How Soft Stretch fixes this</h3>
        <div className="summary-split">
          <div className="summary-split-card">
            <strong>0.70 — Absolute floor</strong>
            <p>
              70% of the earned score is driven by Attainment alone. The cohort has
              zero influence on this portion. A supplier who hits target always
              keeps at least 70% of their max score regardless of who else is
              in the group.
            </p>
          </div>
          <div className="summary-split-card">
            <strong>0.30 × Percentile — Relative reward</strong>
            <p>
              30% of the earned score rewards being better than peers. This
              differentiates suppliers within the cohort, but can only move
              the final score by ±30% around the attainment base.
            </p>
          </div>
        </div>

        <h3 className="summary-subhead">The multiplier range</h3>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Percentile</th>
                <th>Multiplier: 0.70 + 0.30 × P</th>
                <th>Effect on Max Score of 15</th>
              </tr>
            </thead>
            <tbody>
              {[
                { p: "0% (last in cohort)", m: "0.70", e: "15 × Attainment × 0.70" },
                { p: "25%", m: "0.775", e: "15 × Attainment × 0.775" },
                { p: "50%", m: "0.85", e: "15 × Attainment × 0.85" },
                { p: "75%", m: "0.925", e: "15 × Attainment × 0.925" },
                { p: "100% (top of cohort)", m: "1.00", e: "15 × Attainment × 1.00" },
              ].map((r) => (
                <tr key={r.p}>
                  <td>{r.p}</td>
                  <td><strong>{r.m}</strong></td>
                  <td>{r.e}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 className="summary-subhead">Analogy</h3>
        <div className="summary-callout">
          Think of an annual performance review. <strong>70% of your rating</strong> is
          your own output — did you hit your targets? <strong>30% of your rating</strong>{" "}
          is how you compared to your team — were you top or bottom? If your whole team
          had a great year, you should not score <strong>zero</strong> just because you
          ranked last. You still delivered.
        </div>
      </details>

      {/* ── Edge Cases ───────────────────────────────────── */}
      <details className="summary-section" open>
        <summary className="summary-section-summary">6 — Edge Cases &amp; Special Rules</summary>
        <div className="table-frame">
          <table className="data-table summary-table">
            <thead>
              <tr>
                <th>Situation</th>
                <th>Rule Applied</th>
              </tr>
            </thead>
            <tbody>
              {EDGE_CASES.map((r) => (
                <tr key={r.situation}>
                  <td><strong>{r.situation}</strong></td>
                  <td>{r.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* ── Quick Reference ──────────────────────────────── */}
      <details className="summary-section" open>
        <summary id="formula-reference" className="summary-section-summary">7 — Quick Formula Reference</summary>
        <div className="summary-ref-grid">
          <div className="summary-ref-card">
            <span className="summary-ref-label">Percentile</span>
            <code>(N − Rank) / (N − 1)</code>
            <p>Rank 1 = best = 100%. Worst = 0%.</p>
          </div>
          <div className="summary-ref-card">
            <span className="summary-ref-label">Attainment</span>
            <code>(Value − Floor) / (Target − Floor)</code>
            <p>Clamped 0–1. Below floor = 0. At target = 1.</p>
          </div>
          <div className="summary-ref-card summary-ref-highlight">
            <span className="summary-ref-label">Soft Stretch (default)</span>
            <code>Max × Attainment × (0.70 + 0.30 × P)</code>
            <p>70% absolute + 30% relative. Protects against cohort bias.</p>
          </div>
          <div className="summary-ref-card">
            <span className="summary-ref-label">Strict</span>
            <code>Max × Percentile × Attainment</code>
            <p>Rank fully determines score. Last place = near zero.</p>
          </div>
          <div className="summary-ref-card">
            <span className="summary-ref-label">Score %</span>
            <code>Earned Score / Max Score</code>
            <p>Normalised 0–100% view of performance.</p>
          </div>
          <div className="summary-ref-card">
            <span className="summary-ref-label">Tie handling</span>
            <code>Rank = (startRank + endRank) / 2</code>
            <p>Tied suppliers share the average of their ranks.</p>
          </div>
        </div>
      </details>

    </div>
  );
}
