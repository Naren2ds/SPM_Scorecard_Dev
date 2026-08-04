import { useState } from "react";
import { FeedbackPanel } from "../components/FeedbackPanel";
import Co2EmissionPage from "../pages/Co2EmissionPage";
import DotKpiPage from "../pages/DotKpiPageOptimized";
import ScorecardPage from "../ScorecardPage";
import EclipsePage from "../pages/EclipsePage";
import InvoiceConformityPage from "../pages/InvoiceConformityPage";
import IotKpiPage from "../pages/IotKpiPageOptimized";
import PriceDivergencePage from "../pages/PriceDivergencePage";
import SummaryPage from "../pages/SummaryPage";
import SupplierAssessmentPage from "../pages/SupplierAssessmentPage";
import SupplierCompliancePage from "../pages/SupplierCompliancePage";
import SupplierMaturityPage from "../pages/SupplierMaturityPage";

type KpiTab = "summary" | "scorecard" | "dot" | "iot" | "supplierAssessment" | "supplierCompliance" | "supplierMaturity" | "co2Emission" | "eclipse" | "invoiceConformity" | "priceDivergence";

const KPI_TABS: Array<{ id: KpiTab; label: string; shortLabel: string }> = [
  { id: "summary",            label: "Scoring Guide",         shortLabel: "Guide"    },
  { id: "scorecard",          label: "Normalized Scorecard",  shortLabel: "Scorecard"},
  { id: "dot",                label: "DOT KPI",               shortLabel: "SL-DOT"  },
  { id: "supplierAssessment", label: "Supplier Assessment",   shortLabel: "SL-SA"   },
  { id: "supplierCompliance", label: "Supplier Compliance",   shortLabel: "SL-SC"   },
  { id: "iot",                label: "IOT KPI",               shortLabel: "OP-IOT"  },
  { id: "invoiceConformity",  label: "Invoice Conformity",    shortLabel: "OP-IC"   },
  { id: "priceDivergence",    label: "Price Divergence",      shortLabel: "OP-PDIV" },
  { id: "supplierMaturity",   label: "Supplier Maturity",     shortLabel: "SUS-SM"  },
  { id: "eclipse",            label: "Eclipse Score",         shortLabel: "SUS-ECL" },
  { id: "co2Emission",        label: "CO₂ Emission",          shortLabel: "SUS-CO2" },
];

interface KpiPageProps {
  sharedParent: string[];
  onParentChange: (v: string[]) => void;
}

function App() {
  const [activeKpi, setActiveKpi] = useState<KpiTab>("summary");
  const [sharedParent, setSharedParent] = useState<string[]>([]);
  const [feedbackVisible, setFeedbackVisible] = useState(false);
  const feedbackEnabled = activeKpi !== "summary";
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
        <main
          className={`app-shell ${feedbackEnabled && feedbackVisible ? "with-feedback-panel" : ""}`.trim()}
          aria-label={activeLabel}
        >
          {activeKpi === "summary" && <SummaryPage />}
          {activeKpi === "scorecard" && <ScorecardPage />}
          {activeKpi === "dot" && <DotKpiPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "iot" && <IotKpiPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "supplierAssessment" && <SupplierAssessmentPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "supplierCompliance" && <SupplierCompliancePage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "supplierMaturity" && <SupplierMaturityPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "co2Emission" && <Co2EmissionPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "eclipse" && <EclipsePage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "invoiceConformity" && <InvoiceConformityPage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          {activeKpi === "priceDivergence" && <PriceDivergencePage sharedParent={sharedParent} onParentChange={setSharedParent} />}
          <FeedbackPanel
            enabled={feedbackEnabled}
            visible={feedbackVisible}
            pageKey={activeKpi}
            pageLabel={activeLabel}
            onToggleVisible={() => setFeedbackVisible((prev) => !prev)}
          />
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
