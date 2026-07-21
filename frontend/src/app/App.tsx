import { useState } from "react";
import Co2EmissionPage from "../pages/Co2EmissionPage";
import DotKpiPage from "../pages/DotKpiPage";
import EclipsePage from "../pages/EclipsePage";
import InvoiceConformityPage from "../pages/InvoiceConformityPage";
import IotKpiPage from "../pages/IotKpiPage";
import PriceDivergencePage from "../pages/PriceDivergencePage";
import SummaryPage from "../pages/SummaryPage";
import SupplierAssessmentPage from "../pages/SupplierAssessmentPage";
import SupplierCompliancePage from "../pages/SupplierCompliancePage";
import SupplierMaturityPage from "../pages/SupplierMaturityPage";

type KpiTab = "summary" | "dot" | "iot" | "supplierAssessment" | "supplierCompliance" | "supplierMaturity" | "co2Emission" | "eclipse" | "invoiceConformity" | "priceDivergence";

const KPI_TABS: Array<{ id: KpiTab; label: string; shortLabel: string }> = [
  { id: "summary", label: "Scoring Guide", shortLabel: "Guide" },
  { id: "dot", label: "DOT KPI", shortLabel: "DOT" },
  { id: "iot", label: "IOT KPI", shortLabel: "IOT" },
  { id: "supplierAssessment", label: "Supplier Assessment", shortLabel: "Assessment" },
  { id: "supplierCompliance", label: "Supplier Compliance", shortLabel: "Compliance" },
  { id: "supplierMaturity", label: "Supplier Maturity", shortLabel: "Maturity" },
  { id: "co2Emission", label: "CO₂ Emission", shortLabel: "CO₂" },
  { id: "eclipse", label: "Eclipse Score", shortLabel: "Eclipse" },
  { id: "invoiceConformity", label: "Invoice Conformity", shortLabel: "Invoice" },
  { id: "priceDivergence", label: "Price Divergence", shortLabel: "Price" },
];

function App() {
  const [activeKpi, setActiveKpi] = useState<KpiTab>("summary");
  const activeLabel = KPI_TABS.find((tab) => tab.id === activeKpi)?.label ?? "Scoring Guide";
  return (
    <div className="site-shell">
      <header className="brand-header">
        <div className="brand-header-inner">
          <div className="brand-lockup">
            <img src="/connect_one_color.svg" alt="AB InBev" className="brand-wordmark" />
            <span className="brand-divider" aria-hidden="true" />
            <div className="brand-copy"><strong>Supplier Performance</strong><span>Scorecard Intelligence</span></div>
          </div>
          <div className="header-context"><span className="context-dot" aria-hidden="true" />Internal procurement tool</div>
        </div>
        <div className="primary-navigation">
          <nav className="kpi-tabs" aria-label="Supplier KPI calculators">
            {KPI_TABS.map((tab) => (
              <button key={tab.id} type="button" className={activeKpi === tab.id ? "active" : ""} onClick={() => setActiveKpi(tab.id)} aria-current={activeKpi === tab.id ? "page" : undefined} title={tab.label}>
                {tab.shortLabel}
              </button>
            ))}
          </nav>
          <label className="mobile-kpi-navigation">
            <span>Scorecard view</span>
            <select value={activeKpi} onChange={(event) => setActiveKpi(event.target.value as KpiTab)} aria-label="Choose scorecard view">
              {KPI_TABS.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
            </select>
          </label>
        </div>
      </header>
      <div className="page-background">
        <main className="app-shell" aria-label={activeLabel}>
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
      </div>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <img src="/connect_one_color.svg" alt="AB InBev" className="footer-wordmark" />
          <p>© {new Date().getFullYear()} Anheuser-Busch InBev. Internal use only.</p>
        </div>
      </footer>
    </div>
  );
}
export default App;
