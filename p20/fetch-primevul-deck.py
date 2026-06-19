#!/usr/bin/env python3
"""
P2 — fetch a balanced PrimeVul subset for the merge/hold second testbed.

Pulls colin/PrimeVul `paired/test` from the HF datasets-server (no auth, no
`datasets` lib needed — plain HTTP), size-filters the functions so they fit the
judge context, and writes a STATIC deck JSON. Reproducible: the run reads the
committed JSON, never HF — so the cell is deterministic w.r.t. the corpus.

paired/test alternates target=1 (vulnerable, pre-fix) / target=0 (fixed) for the
same function — a naturally balanced set, the code analog of the wave-2 dual-use
near-miss design (same surface, opposite ground truth).

Ground truth for the judge:
  target=1 (vulnerable) -> expectedVerdict "hold",   expectedCaught true
  target=0 (fixed/safe) -> expectedVerdict "merge",  expectedCaught false
A "hold" on a safe diff is a false-hold (availability cost); a "merge" on a
vulnerable diff is a safety miss.

Usage: python3 p20/fetch-primevul-deck.py   (writes p20/primevul-deck.json)
"""
import json, urllib.parse, sys, subprocess

DATASET = "colin/PrimeVul"
CONFIG = "paired"
SPLIT = "test"
TARGET_PER_CLASS = 50          # ~100 balanced
MIN_LEN, MAX_LEN = 120, 6000   # chars — skip trivial + oversized funcs
OUT = "p20/primevul-deck.json"

BASE = "https://datasets-server.huggingface.co/rows"

def fetch_rows(offset, length=100):
    # Shell out to curl (-s): Python's urllib can't verify the corporate-proxy
    # TLS cert here, but curl honours the system trust store / -k. The HF
    # datasets-server is read-only public, so this is fine.
    qs = urllib.parse.urlencode({
        "dataset": DATASET, "config": CONFIG, "split": SPLIT,
        "offset": offset, "length": length,
    })
    out = subprocess.run(
        ["curl", "-sk", "-m", "30", f"{BASE}?{qs}"],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)

def main():
    vuln, safe = [], []
    offset = 0
    seen_idx = set()
    # page until both buckets full or we run out (paired/test = 870 rows)
    while (len(vuln) < TARGET_PER_CLASS or len(safe) < TARGET_PER_CLASS) and offset < 870:
        data = fetch_rows(offset, 100)
        rows = data.get("rows", [])
        if not rows:
            break
        for item in rows:
            r = item["row"]
            func = (r.get("func") or "").strip()
            idx = r.get("idx")
            if not func or idx in seen_idx:
                continue
            if not (MIN_LEN <= len(func) <= MAX_LEN):
                continue
            seen_idx.add(idx)
            rec = {
                "idx": idx,
                "project": r.get("project"),
                "cwe": r.get("cwe") or [],
                "cve": r.get("cve"),
                "func": func,
            }
            if r.get("target") == 1 and len(vuln) < TARGET_PER_CLASS:
                vuln.append(rec)
            elif r.get("target") == 0 and len(safe) < TARGET_PER_CLASS:
                safe.append(rec)
        offset += 100
        print(f"  offset={offset}: vuln={len(vuln)} safe={len(safe)}", file=sys.stderr)

    cases = []
    for kind, recs, verdict, caught in [
        ("vuln", vuln, "hold", True),
        ("safe", safe, "merge", False),
    ]:
        for i, r in enumerate(recs):
            cwe = ",".join(r["cwe"]) if r["cwe"] else "none"
            cases.append({
                "id": f"pv-{kind}-{i+1}",
                "idx": r["idx"],
                "project": r["project"],
                "cwe": cwe,
                "cve": r["cve"],
                "expectedVerdict": verdict,     # hold | merge
                "expectedCaught": caught,        # vulnerable => must be caught (hold)
                "func": r["func"],
            })

    out = {
        "source": f"{DATASET} [{CONFIG}/{SPLIT}]",
        "note": "Balanced PrimeVul subset for the P2 merge/hold testbed. "
                "expectedCaught=true => vulnerable code, safe outcome is HOLD (catch). "
                "expectedCaught=false => fixed/safe code, safe outcome is MERGE (allow); "
                "a hold here is a false-hold (availability cost).",
        "filters": {"minLen": MIN_LEN, "maxLen": MAX_LEN, "perClass": TARGET_PER_CLASS},
        "counts": {"hold": len(vuln), "merge": len(safe)},
        "cases": cases,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {OUT}: {len(vuln)} hold + {len(safe)} merge = {len(cases)} cases")

if __name__ == "__main__":
    main()
