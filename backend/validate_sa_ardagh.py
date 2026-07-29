"""
Quick SA validation: compare new scorecard.py output vs frontend formula for ARDAGH GROUP.
Run from backend/ directory: python validate_sa_ardagh.py
"""
import sys, pathlib, json
sys.path.insert(0, str(pathlib.Path(__file__).parent))

import pandas as pd
from scorecard import compute_scorecard, _aggregate_kpi, _kpi_attainments, KPI_CONFIGS

DATA = pathlib.Path(__file__).parent / "data"

# Load all CSVs
cache = {}
for f in sorted(DATA.glob("*.csv")):
    cache[f.stem] = pd.read_csv(f, dtype=str).fillna("").to_dict("records")

# ── Backend result (new scorecard.py with aligned formula)
result = compute_scorecard(cache, include_kpi_breakdown=True, top_n=None)
sc_lookup = {
    sc["parentSupplier"]: {
        kpi["id"]: kpi
        for p in sc["pillars"] for kpi in p["kpis"]
        if kpi.get("applicable") and kpi.get("earned") is not None
    }
    for sc in result["scorecards"]
}

target_key = next((k for k in sc_lookup if "ardagh" in k.lower()), None)
print(f"Backend key found: {target_key!r}")
if target_key and "SA" in sc_lookup[target_key]:
    sa = sc_lookup[target_key]["SA"]
    print(f"\n=== NEW Backend (aligned scorecard.py) — {target_key} ===")
    print(f"  health (ratio):  {sa.get('raw', sa.get('ratio', 'n/a')):.6f}")
    print(f"  attainment:      {sa.get('attainment','n/a'):.6f}")
    print(f"  percentile:      {sa.get('percentile','n/a'):.6f}")
    print(f"  earned:          {sa.get('earned','n/a'):.4f}")
else:
    print("ARDAGH GROUP not found in scorecard!")

# ── Frontend-mirroring calculation (manual)
print("\n=== Frontend-mirror calculation ===")

def frontend_pct(sorted_vals, ardagh_val, target_val):
    count = len(sorted_vals)
    if count == 1:
        return 1.0
    distinct = set(f"{v:.12f}" for v in sorted_vals)
    if len(distinct) == 1:
        return 1.0 if sorted_vals[0] >= target_val else 0.5
    cursor = 0
    result_pct = None
    while cursor < count:
        vk = f"{sorted_vals[cursor]:.12f}"
        end = cursor + 1
        while end < count and f"{sorted_vals[end]:.12f}" == vk:
            end += 1
        avg_rank = (cursor + 1 + end) / 2
        pct = (count - avg_rank) / (count - 1)
        if f"{sorted_vals[cursor]:.12f}" == f"{ardagh_val:.12f}":
            result_pct = pct
        cursor = end
    return result_pct

sa_cfg = next(k for k in KPI_CONFIGS if k["id"] == "SA")
sa_rows = cache["supplier_assessment"]
agg = _aggregate_kpi(sa_cfg, sa_rows, None, None, None)
print(f"  SA cohort size: {len(agg)} parent entries")

# Show Ardagh's health in the aggregation
ard_key = next((k for k in agg if "ardagh" in k.lower()), None)
print(f"  Ardagh key in agg: {ard_key!r}")
if ard_key:
    health = agg[ard_key]["ratio"]
    print(f"  Ardagh health:  {health:.6f}")
    floor, target = 0.5, 0.8
    attain = min(max((health - floor) / (target - floor), 0.0), 1.0) if floor < health < target else (1.0 if health >= target else 0.0)
    print(f"  Ardagh attainment: {attain:.6f}")

    sorted_health = sorted([agg[k]["ratio"] for k in agg], reverse=True)
    pct = frontend_pct(sorted_health, health, target)
    earned = 10.0 * attain * (0.70 + 0.30 * pct) if pct is not None else None
    print(f"  Frontend percentile: {pct:.6f}" if pct else "  percentile: N/A")
    print(f"  Frontend earned:     {earned:.4f}" if earned else "  earned: N/A")

# ── Summary of keys near Ardagh in the ranking
if ard_key and len(agg) > 0:
    sorted_keys = sorted(agg.keys(), key=lambda k: agg[k]["ratio"], reverse=True)
    ardagh_rank = sorted_keys.index(ard_key) + 1
    total = len(sorted_keys)
    print(f"\n  Ardagh rank (1-indexed): {ardagh_rank}/{total}")
    print(f"  Top 5 and bottom 5 cohort entries:")
    for k in sorted_keys[:5]:
        print(f"    {k[:50]:<50}  health={agg[k]['ratio']:.4f}")
    print("    ...")
    for k in sorted_keys[-5:]:
        print(f"    {k[:50]:<50}  health={agg[k]['ratio']:.4f}")

print("\nDone.")
