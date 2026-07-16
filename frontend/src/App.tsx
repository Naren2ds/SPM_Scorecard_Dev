import { useState } from "react";
import Co2EmissionPage from "./Co2EmissionPage";
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
  | "supplierMaturity"
  | "co2Emission";

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
        <button
          type="button"
          className={activeKpi === "co2Emission" ? "active" : ""}
          onClick={() => setActiveKpi("co2Emission")}
        >
          CO₂ Emission
        </button>
      </nav>

      {activeKpi === "summary" && <SummaryPage />}
      {activeKpi === "dot" && <DotKpiPage />}
      {activeKpi === "supplierAssessment" && <SupplierAssessmentPage />}
      {activeKpi === "supplierCompliance" && <SupplierCompliancePage />}
      {activeKpi === "supplierMaturity" && <SupplierMaturityPage />}
      {activeKpi === "co2Emission" && <Co2EmissionPage />}
    </main>
  );
}

export default App;
