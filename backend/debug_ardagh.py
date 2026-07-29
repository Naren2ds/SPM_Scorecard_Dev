"""Debug script: compare scorecard.py vs frontend computation for Ardagh Group SA."""
import pandas as pd
import sys
import pathlib

DATA = pathlib.Path(__file__).parent / "data"
df = pd.read_csv(DATA / "supplier_assessment.csv", dtype=str).fillna("")

# ── 1. What years exist?
if "year" in df.columns:
    years = sorted(df["year"].unique())
    print(f"Unique years in SA CSV: {years}")
else:
    print("NO 'year' column in SA CSV")

# ── 2. Ardagh Group raw data
ard = df[df["parentSupplier"].str.lower().str.contains("ardagh", na=False)]
print(f"\nArdagh Group rows total: {len(ard)}")
if "year" in df.columns:
    print(ard.groupby("year")[["greenCount", "yellowCount", "redCount"]].apply(
        lambda x: x.apply(pd.to_numeric, errors="coerce").sum()
    ).to_string())

# ── 3. Backend computation: ALL years, backend percentile formula
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from scorecard import compute_scorecard, KPI_CONFIGS

cache = {}
for f in DATA.glob("*.csv"):
    cache[f.stem] = pd.read_csv(f, dtype=str).fillna("").to_dict("records")

result = compute_scorecard(cache, include_kpi_breakdown=True, top_n=None)
ardagh_sc = next(
    (x for x in result["scorecards"] if "ardagh" in x["parentSupplier"].lower()), None
)
if ardagh_sc:
    sa_kpi = next(
        (k for p in ardagh_sc["pillars"] for k in p["kpis"] if k["id"] == "SA"), None
    )
    print(f"\n=== Backend (ALL years) ===")
    if sa_kpi:
        print(f"  health (ratio):  {sa_kpi.get('raw', 'n/a')}")
        print(f"  attainment:      {sa_kpi.get('attainment', 'n/a')}")
        print(f"  percentile:      {sa_kpi.get('percentile', 'n/a')}")
        print(f"  earned:          {sa_kpi.get('earned', 'n/a')}")
    else:
        print("  SA KPI not found in breakdown")
else:
    print("\nArdagh Group not found in scorecard result")

# ── 4. Frontend computation: YEAR filter 2025+2026, frontend percentile formula
FRONT_YEARS = {"2025", "2026"}
def frontend_percentile(sorted_vals, ardagh_val):
    """Compute percentile using frontend formula (count-rank)/(count-1) with midpoint for ties."""
    count = len(sorted_vals)
    if count == 1:
        return 1.0
    cursor = 0
    result_pct = None
    while cursor < len(sorted_vals):
        val_key = f"{sorted_vals[cursor]:.12f}"
        end = cursor + 1
        while end < len(sorted_vals) and f"{sorted_vals[end]:.12f}" == val_key:
            end += 1
        rank = (cursor + 1 + end) / 2
        percentile = (count - rank) / (count - 1)
        if f"{sorted_vals[cursor]:.12f}" == f"{ardagh_val:.12f}":
            result_pct = percentile
        cursor = end
    return result_pct

# Filter to 2025+2026 if year column exists
if "year" in df.columns:
    df_front = df[df["year"].isin(FRONT_YEARS)]
    print(f"\n=== Frontend year filter (2025+2026): {len(df_front)} rows ===")
else:
    df_front = df
    print(f"\n=== No year filter (no year column): {len(df_front)} rows ===")

# Aggregate by parent
applicable = df_front[df_front["kpiApplicability"].str.lower() != "not applicable"]
grp = applicable.groupby("parentSupplier").apply(
    lambda g: pd.Series({
        "greenCount": pd.to_numeric(g["greenCount"], errors="coerce").fillna(0).sum(),
        "yellowCount": pd.to_numeric(g["yellowCount"], errors="coerce").fillna(0).sum(),
        "redCount": pd.to_numeric(g["redCount"], errors="coerce").fillna(0).sum(),
    })
).reset_index()
grp["total"] = grp["greenCount"] + grp["yellowCount"] + grp["redCount"]
grp = grp[grp["total"] > 0]
grp["health"] = (grp["greenCount"] * 1.0 + grp["yellowCount"] * 0.5) / grp["total"]

# Attainment
floor, target = 0.5, 0.8
def attainment(h):
    if h < floor: return 0.0
    if h >= target: return 1.0
    return (h - floor) / (target - floor)
grp["attainment"] = grp["health"].apply(attainment)

# Percentile (frontend formula)
sorted_health = sorted(grp["health"].tolist(), reverse=True)
ardagh_row = grp[grp["parentSupplier"].str.lower().str.contains("ardagh", na=False)]
if len(ardagh_row) > 0:
    ardagh_health = ardagh_row.iloc[0]["health"]
    ardagh_attain = ardagh_row.iloc[0]["attainment"]
    front_pct = frontend_percentile(sorted_health, ardagh_health)
    front_earned = 10.0 * ardagh_attain * (0.70 + 0.30 * front_pct) if front_pct is not None else None
    print(f"\n=== Frontend (2025+2026, frontend percentile formula) ===")
    print(f"  health:          {ardagh_health:.6f}")
    print(f"  attainment:      {ardagh_attain:.6f}")
    print(f"  percentile:      {front_pct}")
    print(f"  earned:          {front_earned}")
    print(f"\n  N parents in cohort: {len(grp)}")
else:
    print("\nArdagh not found in frontend filtered data")

# ── 5. Backend formula but 2025+2026 years only (hybrid)
if "year" in df.columns:
    cache_filtered = {}
    for k, v in cache.items():
        if k == "supplier_assessment":
            cache_filtered[k] = [r for r in v if r.get("year", "") in FRONT_YEARS]
        else:
            cache_filtered[k] = v
    result2 = compute_scorecard(cache_filtered, include_kpi_breakdown=True, top_n=None)
    ardagh_sc2 = next(
        (x for x in result2["scorecards"] if "ardagh" in x["parentSupplier"].lower()), None
    )
    if ardagh_sc2:
        sa2 = next(
            (k for p in ardagh_sc2["pillars"] for k in p["kpis"] if k["id"] == "SA"), None
        )
        print(f"\n=== Backend (2025+2026 only, backend percentile formula) ===")
        if sa2:
            print(f"  health:          {sa2.get('raw', 'n/a')}")
            print(f"  attainment:      {sa2.get('attainment', 'n/a')}")
            print(f"  percentile:      {sa2.get('percentile', 'n/a')}")
            print(f"  earned:          {sa2.get('earned', 'n/a')}")
