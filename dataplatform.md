# S3 cost-optimisation plan — `cko-bi-snowflake-prod`

Account: `851392519502` · Region: `eu-west-1` · Date: 2026-05-01

## Current state

| Property | Value |
|---|---|
| Size | 3.40 PB (Standard only) |
| Objects | 4.18 B |
| 30-day growth | +60.5 TB, +51.6 M objects (monotonic, no deletions) |
| Versioning | Enabled, MFA Delete off |
| Encryption | SSE-KMS (`182bb947-daff-49a4-9e4a-5c67db6cb131`), **Bucket Keys disabled** |
| Public Access Block | All four flags on |
| Lifecycle rules | **None** |
| Inventory | **None configured** |
| Storage Lens | `dataplatform` config, **free tier only** (no advanced metrics/export) |
| Replication | `gateway_usa/` → `cdp-usa-gateway-transactions-prod` |
| Notifications | SNS on `Frames/cardTokenized*.json`, `prism-forward-play/*` |
| Multipart uploads | ≥1000 in-progress, oldest 2020-03-20 (~5 yr of unpaid-for-but-billed parts) |
| Tags | `Environment=prod`, `Team=dp`, `Service=snowflake`, `Product=data-platform` |

Cost at 3.4 PB Standard (eu-west-1 tiered pricing): **~$76 k/month**.

## Quick wins (do first, no prefix analysis needed)

1. **Enable S3 Bucket Keys** — SSE-KMS with Bucket Keys off means every PUT on 4.18 B objects calls `GenerateDataKey`. Enabling typically cuts KMS cost by >99%. One-line change.
2. **Abort-Incomplete-Multipart-Upload lifecycle rule** — `AbortIncompleteMultipartUpload = 7 days`, applied bucket-wide. Cleans up ≥1000 orphaned uploads dating to 2020 and prevents recurrence. Free money.
3. **Enable S3 Inventory** — daily Parquet reports delivered to `cko-bi-snowflake-prod-logs/inventory/cko-bi-snowflake-prod/`. Destination bucket policy + SSE-S3 encryption already in place; no KMS grant needed. First report lands ~48 h.
4. **Noncurrent-version lifecycle** — transition noncurrent versions to Glacier IR after 30 d, expire after 365 d. Needed because versioning is on with no cleanup.

## Starter prefixes for Glacier Deep Archive

High-confidence dormant prefixes — not in replication, notification filters, or bucket-policy cross-account grants:

| Prefix | Earliest sampled | Notes |
|---|---|---|
| `archive/` | 2021-02 | name says it all |
| `bkp/` | 2021-06 | backup |
| `NAS/` | 2020-04 | legacy sibling of `echo-nas/` |
| `echo-nas/` | 2020-07 | firehose archive, ~10 KB gz files (verify avg size first) |
| `airflow-bob/` | 2021-02 | deprecated Airflow instance |
| `Bob/` | 2020-02 | legacy, small |
| `Ekata/` | 2020-03 | deprecated vendor |
| `temp-gwc-dynamodb-18-oct/` | 2023-10 | one-off DynamoDB export; consider deletion over archive |
| `prism-forward-play/` | 2021-08 | Prism replay artefacts |

**Target class:** Glacier Deep Archive ($0.00099/GB-month, 12 h restore, 180 d minimum duration).
**Filter:** `minimum object size = 1 MB` (protects against per-object metadata overhead of 8 KB Standard + 32 KB Deep per object — small files cost more in Deep than in Standard).
**Transition:** `days after object creation = 0` (transition immediately on next eval; all listed data is already >180 d old).

## Delete candidates (not archive)

- `test-bulk-loading/` (2021-01) — test data
- `pipeline-test-fd-pre3ds-events/` (2024-03) — "test" prefix, Spark checkpoints
- `temp-gwc-dynamodb-18-oct/` — one-off export; likely safe to delete after owner check

## Verify-with-owner list (cold-looking but not certain)

- `scratch/`, `tmp/` — writes continued into 2024 despite naming
- `implyHistoricalPayment/`, `implyPayinHourly/`, `implyProcessingChannel/` — candidates for Deep Archive if Imply is retired
- `marketing_gcp/`, `neustar-ip/`, `trulioo/`, `pathward/`, `crb/` — vendor/integration prefixes; confirm with data-platform
- `due-diligence-*` (12 prefixes) — KYC/KYB data. **Regulatory retention review required** before any tier change

## Do NOT touch

- `gateway_usa/` — actively replicated to USA bucket
- `Frames/cardTokenized*`, `Prism/RawData/*` — active SNS consumers
- `looker/*`, `data-science/*`, `marketing/*`, `mobile-sdk/*`, `merchant_terminations/*`, `landing/abacus/*` — cross-account writers/readers in bucket policy
- `_task_reports/`, `_manifests/` — very recent (2026-04) metadata, likely active
- `tl_corrections_replay/`, `backfill-metadata-cdp-stream-plc/` — live replay artefacts (writes into 2025)

## Storage-class economics (eu-west-1 list price, per GB/month)

| Class | $/GB/mo | vs Standard | Per 1 PB/mo | Min duration | Per-object overhead |
|---|---:|---:|---:|---|---|
| Standard (>500 TB tier) | $0.0210 | 1.00× | $22,020 | — | none |
| Standard-IA | $0.0125 | 0.60× | $13,107 | 30 d | none |
| One Zone-IA | $0.0100 | 0.48× | $10,486 | 30 d | none |
| Glacier Instant Retrieval | $0.0040 | 0.19× | $4,194 | 90 d | 128 KB min billable |
| Glacier Flexible Retrieval | $0.0036 | 0.17× | $3,775 | 90 d | 8 KB Std + 32 KB Flex |
| **Glacier Deep Archive** | **$0.00099** | **0.047×** | **$1,038** | 180 d | 8 KB Std + 32 KB Deep |

**Transition fee:** $0.05/1k objects for Deep Archive. 100 M objects = $5k one-off.
**Retrieval:** Deep Archive bulk = $0.0025/GB + $0.025/1k restore, 48 h.

## Recommended order of operations

1. Enable Bucket Keys + abort-MPU lifecycle + Inventory + noncurrent-version lifecycle (quick wins, ~1 hour work).
2. While Inventory populates (~48 h), create Deep-Archive transition rules for the 9 high-confidence prefixes with a 1 MB minimum-size filter.
3. Compute avg object size per prefix from Inventory output via Athena.
4. Triage verify-list prefixes with owners; add transition rules where sign-off lands.
5. Handle `due-diligence-*` separately via compliance review.

## Open questions

- Should `dataplatform` Storage Lens be upgraded to advanced metrics? Gives prefix-level sizing, activity metrics, and CloudWatch publishing. Needed if we want ongoing visibility rather than one-off Inventory analysis.
- Who owns the `due-diligence-*` retention policy? Can Deep Archive satisfy regulatory "must be retrievable within X days" requirements?
- Is anything still writing to the abandoned MPUs, or is 7 d abort safe bucket-wide?
