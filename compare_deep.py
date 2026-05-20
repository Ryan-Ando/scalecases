import csv
from collections import defaultdict

TMPDIR = "C:/Users/ryana/AppData/Local/Temp"

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
dates = sorted(day_map.values())

# ------- Load Hyros -------
hyros_data = defaultdict(lambda: defaultdict(int))
for day_key in sorted(day_map.keys()):
    date_str = day_map[day_key]
    with open(f"{TMPDIR}/hyros_{day_key}.csv", "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            adset_id = row.get("Ad Set ID", "").strip()
            try:
                leads = int(row.get("Leads Total", "0").strip())
            except:
                leads = 0
            if adset_id and adset_id != "-" and leads > 0:
                hyros_data[date_str][adset_id] = leads

# ------- Load Lead Events -------
our_data = defaultdict(lambda: defaultdict(int))
bad_rows = []

with open(f"{TMPDIR}/lead_events.csv", "r", encoding="utf-8") as f:
    reader = csv.reader(f)
    for i, row in enumerate(reader):
        if len(row) < 3:
            continue
        date_str = row[1].strip()
        adset_id = row[2].strip()
        if not date_str.startswith("2026-04-"):
            continue
        if adset_id in ("{{adset.id}}", ""):
            bad_rows.append((i+1, date_str, adset_id, row[8] if len(row) > 8 else ""))
            continue
        our_data[date_str][adset_id] += 1

# ------- Adsets in Hyros not in our sheet, broken out by day -------
hyros_all = set()
our_all = set()
for d in dates:
    hyros_all.update(hyros_data[d].keys())
    our_all.update(our_data[d].keys())

only_in_hyros = hyros_all - our_all
only_in_ours = our_all - hyros_all
in_both = hyros_all & our_all

print(f"Unique adsets Hyros: {len(hyros_all)}")
print(f"Unique adsets Ours:  {len(our_all)}")
print(f"In both: {len(in_both)}")
print(f"Only in Hyros: {len(only_in_hyros)}")
print(f"Only in Ours:  {len(only_in_ours)}")
print(f"Rows with bad adset ID: {len(bad_rows)}")
if bad_rows:
    for r in bad_rows:
        print(f"  Row {r[0]}: date={r[1]}, adset='{r[2]}', dedup_key snippet='{r[3][:60]}'")

# ------- Full adset+day breakdown for all mismatches -------
print("\n=== ALL ADSET+DAY DISCREPANCIES (any diff != 0) ===")
print(f"{'Date':<13} {'Adset ID':<26} {'Hyros':>6} {'Ours':>6} {'Diff':>6}")
print("-" * 65)
total_discrepancy_rows = 0
for date_str in dates:
    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o = our_data[date_str].get(adset, 0)
        diff = o - h
        if diff != 0:
            total_discrepancy_rows += 1
            flag = " ***" if abs(diff) > 1 else ""
            print(f"{date_str:<13} {adset:<26} {h:>6} {o:>6} {diff:>+6}{flag}")
print(f"\nTotal discrepancy rows: {total_discrepancy_rows}")

# ------- Count how many are +1 vs -1 vs larger -------
plus1 = minus1 = larger = 0
for date_str in dates:
    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o = our_data[date_str].get(adset, 0)
        diff = o - h
        if diff == 1:
            plus1 += 1
        elif diff == -1:
            minus1 += 1
        elif diff != 0:
            larger += 1

print(f"\nDiscrepancy breakdown:")
print(f"  +1 (ours has 1 more): {plus1}")
print(f"  -1 (hyros has 1 more): {minus1}")
print(f"  Larger diff (>1 or <-1): {larger}")

# ------- Day-shift analysis: for adsets with mismatches, check if ours is +1 or -1 day -------
print("\n=== DAY-SHIFT DETAILED ANALYSIS ===")
print("Checking: for each adset where our date differs from Hyros date, count shift direction")

# For every adset that appears in both but on different days OR with different counts:
# Track which day Hyros says leads came in vs which day we say
shift_forward = 0   # our date is 1 day AFTER hyros date
shift_back = 0      # our date is 1 day BEFORE hyros date
no_shift = 0

# For adsets where counts differ, let's look at where the 'missing' lead ended up
# Strategy: for each (adset, date) where Hyros count > Our count:
#   Check if our_data[next_day][adset] or our_data[prev_day][adset] makes up the difference
forward_shifts = []  # our count appears day later than Hyros
backward_shifts = []  # our count appears day earlier than Hyros

for i, date_str in enumerate(dates):
    prev_day = dates[i-1] if i > 0 else None
    next_day = dates[i+1] if i < len(dates)-1 else None

    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o_same = our_data[date_str].get(adset, 0)
        o_prev = our_data[prev_day].get(adset, 0) if prev_day else 0
        o_next = our_data[next_day].get(adset, 0) if next_day else 0
        h_prev = hyros_data[prev_day].get(adset, 0) if prev_day else 0
        h_next = hyros_data[next_day].get(adset, 0) if next_day else 0

        if h > o_same:
            # We're missing some leads that Hyros shows on this date
            missing = h - o_same
            # Check if they show up in our next day
            if o_next > h_next:
                # More likely these shifted forward 1 day
                forward_shifts.append((adset, date_str, next_day, missing, h, o_same, o_next))
            elif o_prev > h_prev and prev_day:
                # More likely shifted backward
                backward_shifts.append((adset, date_str, prev_day, missing, h, o_same, o_prev))

print(f"\nAdset+day combos where our count is lower than Hyros and next-day ours is higher than Hyros:")
print(f"  (Possible forward shift: our sheet records lead 1 day LATER than Hyros)")
for item in forward_shifts[:30]:
    adset, h_date, our_date, missing, h_count, o_same, o_next = item
    print(f"  {adset}: Hyros={h_count} on {h_date}, Ours={o_same} same day, Ours={o_next} on {our_date}")

print(f"\nTotal possible forward-shift cases: {len(forward_shifts)}")

print(f"\nAdset+day combos where our count is lower and PREV day ours is higher than Hyros:")
print(f"  (Possible backward shift: our sheet records lead 1 day EARLIER than Hyros)")
for item in backward_shifts[:30]:
    adset, h_date, our_date, missing, h_count, o_same, o_prev = item
    print(f"  {adset}: Hyros={h_count} on {h_date}, Ours={o_same} same day, Ours={o_prev} on {our_date}")
print(f"\nTotal possible backward-shift cases: {len(backward_shifts)}")

# ------- Specific adsets consistently wrong -------
print("\n=== ADSETS WITH MULTIPLE MISMATCHES ACROSS DAYS ===")
adset_mismatch_count = defaultdict(int)
adset_mismatch_detail = defaultdict(list)
for date_str in dates:
    all_adsets = set(hyros_data[date_str].keys()) | set(our_data[date_str].keys())
    for adset in sorted(all_adsets):
        h = hyros_data[date_str].get(adset, 0)
        o = our_data[date_str].get(adset, 0)
        if h != o:
            adset_mismatch_count[adset] += 1
            adset_mismatch_detail[adset].append(f"{date_str[-5:]}: H={h} O={o}")

print(f"{'Adset ID':<26} {'Mismatch Days':>13}  Detail")
for adset, cnt in sorted(adset_mismatch_count.items(), key=lambda x: -x[1]):
    if cnt >= 2:
        detail = ", ".join(adset_mismatch_detail[adset])
        print(f"{adset:<26} {cnt:>13}  {detail}")
