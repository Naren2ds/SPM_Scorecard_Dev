import { useState } from "react";
import DotKpiPage from "./DotKpiPage";
import SummaryPage from "./SummaryPage";
import SupplierAssessmentPage from "./SupplierAssessmentPage";

type KpiTab = "summary" | "dot" | "supplierAssessment";

function App() {
  const [activeKpi, setActiveKpi] = useState<KpiTab>("summary");

  return (
    <main className="app-shell">
      <nav className="kpi-tabs" aria-label="Supplier KPI calculators">
        <button
          type="button"
          className={activeKpi === "summary" ? "active" : ""}
          onClick={() => setActiveKpi("summary")}
        >
          Scoring Guide
        </button>
        <button
          type="button"
          className={activeKpi === "dot" ? "active" : ""}
          onClick={() => setActiveKpi("dot")}
        >
          DOT KPI
        </button>
        <button
          type="button"
          className={activeKpi === "supplierAssessment" ? "active" : ""}
          onClick={() => setActiveKpi("supplierAssessment")}
        >
          Supplier Assessment
        </button>
      </nav>

      {activeKpi === "summary" && <SummaryPage />}
      {activeKpi === "dot" && <DotKpiPage />}
      {activeKpi === "supplierAssessment" && <SupplierAssessmentPage />}
    </main>
  );
}

export default App;
