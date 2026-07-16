import { useState } from "react";
import DotKpiPage from "./DotKpiPage";
import SummaryPage from "./SummaryPage";
import SupplierAssessmentPage from "./SupplierAssessmentPage";
import SupplierCompliancePage from "./SupplierCompliancePage";
import SupplierMaturityPage from "./SupplierMaturityPage";

type KpiTab =
  | "summary"
  | "dot"
  | "supplierAssessment"
  | "supplierCompliance"
  | "supplierMaturity";

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
        <button
          type="button"
          className={activeKpi === "supplierCompliance" ? "active" : ""}
          onClick={() => setActiveKpi("supplierCompliance")}
        >
          Supplier Compliance
        </button>
        <button
          type="button"
          className={activeKpi === "supplierMaturity" ? "active" : ""}
          onClick={() => setActiveKpi("supplierMaturity")}
        >
          Supplier Maturity
        </button>
      </nav>

      {activeKpi === "summary" && <SummaryPage />}
      {activeKpi === "dot" && <DotKpiPage />}
      {activeKpi === "supplierAssessment" && <SupplierAssessmentPage />}
      {activeKpi === "supplierCompliance" && <SupplierCompliancePage />}
      {activeKpi === "supplierMaturity" && <SupplierMaturityPage />}
    </main>
  );
}

export default App;
