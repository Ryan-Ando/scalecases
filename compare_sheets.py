import csv
import os
from collections import defaultdict

# Parse Hyros sheets - count leads per adset per day
hyros_data = defaultdict(lambda: defaultdict(int))

day_map = {
    "Apr14": "2026-04-14",
    "Apr15": "2026-04-15",
    "Apr16": "2026-04-16",
    "Apr17": "2026-04-17",
    "Apr18": "2026-04-18",
    "Apr19": "2026-04-19",
    "Apr20": "2026-04-20",
    "Apr21": "2026-04-21",
    "Apr22": "2026-04-22",
    "Apr23": "2026-04-23",
    "Apr24": "2026-04-24",
    "Apr25": "2026-04-25",
    "Apr26": "2026-04-26",
    "Apr27": "2026-04-27",
}

hyros_totals = {}
hyros_all_adsets = set()

for day_key in sorted(day_map.keys()):
    date_str = day_map[day_key]
    filepath = f"C:/Users/ryana/AppData/Local/Temp/hyros_{day_key}.csv"
    day_total = 0
    with open(filepath, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            adset_id = row.get("Ad Set ID", "").strip()
            leads_str = row.get("Leads Total", "0").strip()
            try:
                leads = int(leads_str)
            except:
                leads = 0
            if adset_id and adset_id != "-" and leads > 0:
                hyros_data[date_str][adset_id] = leads
                day_total += leads
                hyros_all_adsets.add(adset_id)
    hyros_totals[date_str] = day_total

print("=== HYROS TOTALS BY DAY ===")
for date_str in sorted(hyros_totals.keys()):
    print(f"  {date_str}: {hyros_totals[date_str]} leads, {len(hyros_data[date_str])} adsets")
print(f"  TOTAL: {sum(hyros_totals.values())} leads")
print(f"  Unique adsets: {len(hyros_all_adsets)}")

# ---- Parse Lead Events sheet ----
our_data = defaultdict(lambda: defaultdict(int))   # our_data[date][adset_id] = count
our_totals = {}
our_all_adsets = set()
bad_adset_rows = 0

with open("C:/Users/ryana/AppData/Local/Temp/lead_events.csv", "r", encoding="utf-8") as f:
    reader = csv.reader(f)
    for row in reader:
        if len(row) < 3:
            continue
        timestamp = row[0].strip()
        date_str = row[1].strip()
        adset_id = row[2].strip()
        # Skip rows without a valid date in range
        if not date_str.startswith("2026-04-"):
            continue
        if adset_id == "{{adset.id}}" or adset_id == "":
            bad_adset_rows += 1
            continue
        our_data[date_str][adset_id] += 1
        our_all_adsets.add(adset_id)

for date_str in sorted(day_map.values()):
    our_totals[date_str] = sum(our_data[date_str].values())

print("\n=== OUR LEAD EVENTS TOTALS BY DAY ===")
for date_str in sorted(our_totals.keys()):
    print(f"  {date_str}: {our_totals[date_str]} leads, {len(our_data[date_str])} adsets")
print(f"  TOTAL: {sum(our_totals.values())} leads")
print(f"  Unique adsets: {len(our_all_adsets)}")
print(f"  Rows with bad/missing adset ID: {bad_adset_rows}")

# ---- Per-day comparison table ----
print("\n=== PER-DAY COMPARISON ===")
print(f"{'Date':<15} {'Hyros':>8} {'Ours':>8} {'Diff':>8}")
print("-" * 42)
total_hyros = 0
total_ours = 0
for date_str in sorted(day_map.values()):
    h = hyros_totals.get(date_str, 0)
    o = our_totals.get(date_str, 0)
    diff = o - h
    flag = " <-- MISMATCH" if abs(diff) > 1 else ""
    print(f"{date_str:<15} {h:>8} {o:>8} {diff:>+8}{flag}")
    total_hyros += h
    total_ours += o
print("-" * 42)
print(f"{'TOTAL':<15} {total_hyros:>8} {total_ours:>8} {total_ours-total_hyros:>+8}")

# ---- Per adset+day mismatches ----
print("\n=== ADSET+DAY MISMATCHES (diff > 1) ===")
mismatches = []
for date_str in sorted(day_map.values()):
    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o = our_data[date_str].get(adset, 0)
        diff = o - h
        if abs(diff) > 1:
            mismatches.append((date_str, adset, h, o, diff))

if mismatches:
    print(f"{'Date':<15} {'Adset ID':<25} {'Hyros':>8} {'Ours':>8} {'Diff':>8}")
    print("-" * 70)
    for date_str, adset, h, o, diff in mismatches:
        print(f"{date_str:<15} {adset:<25} {h:>8} {o:>8} {diff:>+8}")
else:
    print("  None found (all diffs <= 1)")

# ---- Adsets in Hyros but NOT in our sheet (for dates in range) ----
print("\n=== ADSETS IN HYROS BUT NOT IN OUR SHEET ===")
missing_from_ours = hyros_all_adsets - our_all_adsets
print(f"  Count: {len(missing_from_ours)}")
# For each, show which days and how many leads
for adset in sorted(missing_from_ours):
    days_info = []
    for date_str in sorted(day_map.values()):
        h = hyros_data[date_str].get(adset, 0)
        if h > 0:
            days_info.append(f"{date_str[-5:]}:{h}")
    print(f"  {adset}  [{', '.join(days_info)}]")

print("\n=== ADSETS IN OUR SHEET BUT NOT IN HYROS ===")
missing_from_hyros = our_all_adsets - hyros_all_adsets
print(f"  Count: {len(missing_from_hyros)}")
for adset in sorted(missing_from_hyros):
    days_info = []
    for date_str in sorted(day_map.values()):
        o = our_data[date_str].get(adset, 0)
        if o > 0:
            days_info.append(f"{date_str[-5:]}:{o}")
    print(f"  {adset}  [{', '.join(days_info)}]")

# ---- Cross-day mismatches: leads in Hyros on day X but in our sheet on a different day ----
print("\n=== CROSS-DAY DATE SHIFT ANALYSIS ===")
print("For each adset where day-level counts don't match, check if leads appear shifted by 1 day")
shift_candidates = []
dates = sorted(day_map.values())
for date_str in dates:
    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o = our_data[date_str].get(adset, 0)
        if h != o and h > 0:
            # Check adjacent days in our sheet
            idx = dates.index(date_str)
            prev_day = dates[idx-1] if idx > 0 else None
            next_day = dates[idx+1] if idx < len(dates)-1 else None
            o_prev = our_data[prev_day].get(adset, 0) if prev_day else 0
            o_next = our_data[next_day].get(adset, 0) if next_day else 0
            if o_prev > 0 or o_next > 0:
                shift_candidates.append({
                    "adset": adset,
                    "hyros_date": date_str,
                    "hyros_count": h,
                    "our_count_same_day": o,
                    "our_count_prev_day": o_prev,
                    "our_count_next_day": o_next,
                    "prev_day": prev_day,
                    "next_day": next_day,
                })

if shift_candidates:
    shown = set()
    for c in shift_candidates:
        key = (c["adset"], c["hyros_date"])
        if key in shown:
            continue
        shown.add(key)
        print(f"  Adset {c['adset']}: Hyros has {c['hyros_count']} on {c['hyros_date']}, "
              f"we have {c['our_count_same_day']} same day, "
              f"{c['our_count_prev_day']} on {c['prev_day']}, "
              f"{c['our_count_next_day']} on {c['next_day']}")
else:
    print("  No obvious shift patterns found")
