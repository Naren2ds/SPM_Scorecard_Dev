import { useState } from "react";
import Co2EmissionPage from "./Co2EmissionPage";
import DotKpiPage from "./DotKpiPage";
import EclipsePage from "./EclipsePage";
import InvoiceConformityPage from "./InvoiceConformityPage";
import IotKpiPage from "./IotKpiPage";
import PriceDivergencePage from "./PriceDivergencePage";
import SummaryPage from "./SummaryPage";
import SupplierAssessmentPage from "./SupplierAssessmentPage";
import SupplierCompliancePage from "./SupplierCompliancePage";
import SupplierMaturityPage from "./SupplierMaturityPage";

type KpiTab =
  | "summary"
  | "dot"
  | "iot"
  | "supplierAssessment"
  | "supplierCompliance"
  | "supplierMaturity"
  | "co2Emission"
  | "eclipse"
  | "invoiceConformity"
  | "priceDivergence";

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
          className={activeKpi === "iot" ? "active" : ""}
          onClick={() => setActiveKpi("iot")}
        >
          IOT KPI
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
        <button
          type="button"
          className={activeKpi === "eclipse" ? "active" : ""}
          onClick={() => setActiveKpi("eclipse")}
        >
          Eclipse Score
        </button>
        <button
          type="button"
          className={activeKpi === "invoiceConformity" ? "active" : ""}
          onClick={() => setActiveKpi("invoiceConformity")}
        >
          Invoice Conformity
        </button>
        <button
          type="button"
          className={activeKpi === "priceDivergence" ? "active" : ""}
          onClick={() => setActiveKpi("priceDivergence")}
        >
          Price Divergence
        </button>
      </nav>

      {activeKpi === "summary" && <SummaryPage />}
      {activeKpi === "dot" && <DotKpiPage />}
      {activeKpi === "iot" && <IotKpiPage />}
      {activeKpi === "supplierAssessment" && <SupplierAssessmentPage />}
      {activeKpi === "supplierCompliance" && <SupplierCompliancePage />}
      {activeKpi === "supplierMaturity" && <SupplierMaturityPage />}
      {activeKpi === "co2Emission" && <Co2EmissionPage />}
      {activeKpi === "eclipse" && <EclipsePage />}
      {activeKpi === "invoiceConformity" && <InvoiceConformityPage />}
      {activeKpi === "priceDivergence" && <PriceDivergencePage />}
    </main>
  );
}

export default App;
