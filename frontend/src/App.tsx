import { useState } from "react";
import DotKpiPage from "./DotKpiPage";
import IotKpiPage from "./IotKpiPage";
import SummaryPage from "./SummaryPage";

type KpiTab = "summary" | "dot" | "iot";

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
      </nav>

      {activeKpi === "summary" && <SummaryPage />}
      {activeKpi === "dot" && <DotKpiPage />}
      {activeKpi === "iot" && <IotKpiPage />}
    </main>
  );
}

export default App;
