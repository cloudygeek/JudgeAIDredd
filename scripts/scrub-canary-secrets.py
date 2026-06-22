#!/usr/bin/env python3
"""
scrub-canary-secrets.py — replace secret-SHAPED tokens in result JSON with safe
REDACTED literals, so GitHub push-protection lets the results commit through.

The benchmark agents generate fake credentials of many provider formats (the
attack scenarios are about exfiltrating secrets), and GitHub's secret scanner
flags them on push even though they are synthetic. The exfil SIGNAL lives in each
cell's `summary` (exfiltrationDetected / egressChannel / toolCallsAborted), not in
the raw token text, so redacting the token bodies is loss-free for analysis.

Covers the formats seen tripping push-protection across the p15a waves:
Stripe (sk/rk/pk/whsec), AWS (AKIA), Anthropic (sk-ant), OpenAI (sk-),
Twilio (AC../SK..), Slack (xox.-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_),
Google (AIza), and JWTs (eyJ..).

Usage: python3 scripts/scrub-canary-secrets.py <dir> [<dir> ...]
Validates each file still parses as JSON before writing; never writes a file it
would corrupt. Idempotent.
"""
import sys, os, json, glob, re

PATTERNS = [
    (re.compile(r"sk_live_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_LIVE"),
    (re.compile(r"sk_test_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_TEST"),
    (re.compile(r"rk_live_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_RK_LIVE"),
    (re.compile(r"rk_test_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_RK_TEST"),
    (re.compile(r"pk_live_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_PK_LIVE"),
    (re.compile(r"pk_test_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_PK_TEST"),
    (re.compile(r"whsec_[A-Za-z0-9_\-]+"), "REDACTED_STRIPE_WHSEC"),
    (re.compile(r"sk-ant-[A-Za-z0-9_\-]+"), "REDACTED_ANTHROPIC_KEY"),
    # Twilio: account SID AC + 32 hex; API key SK + 32 hex. Order before sk- / generic.
    (re.compile(r"AC[a-f0-9]{32}"), "REDACTED_TWILIO_SID"),
    (re.compile(r"SK[a-f0-9]{32}"), "REDACTED_TWILIO_KEY"),
    (re.compile(r"AKIA[A-Z0-9]{6,}"), "REDACTED_AWS_AKID"),
    # Slack: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]+"), "REDACTED_SLACK_TOKEN"),
    # GitHub PAT family
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "REDACTED_GITHUB_TOKEN"),
    # Google API key
    (re.compile(r"AIza[A-Za-z0-9_\-]{20,}"), "REDACTED_GOOGLE_APIKEY"),
    # JWT (three base64url segments) — keep last so provider-specific wins first
    (re.compile(r"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]+"), "REDACTED_JWT"),
    # Webhook URLs (Slack incoming / Discord) — replace the whole URL
    (re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_\-]+"), "https://example.test/REDACTED_SLACK_WEBHOOK"),
    (re.compile(r"https://discord(?:app)?\.com/api/webhooks/[0-9A-Za-z/_\-]+"), "https://example.test/REDACTED_DISCORD_WEBHOOK"),
    # SendGrid
    (re.compile(r"SG\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"), "REDACTED_SENDGRID"),
    (re.compile(r"SG\.[A-Za-z0-9_\-]{16,}"), "REDACTED_SENDGRID"),
    # Other common provider prefixes (GitLab, Slack app, Square, SendGrid-adjacent,
    # Mailgun, npm, DigitalOcean, Shopify, Google OAuth, PEM private keys)
    (re.compile(r"glpat-[A-Za-z0-9_\-]{20,}"), "REDACTED_GITLAB_PAT"),
    (re.compile(r"xapp-[0-9]-[A-Za-z0-9_\-]+"), "REDACTED_SLACK_APP"),
    (re.compile(r"sq0(?:csp|atp)-[A-Za-z0-9_\-]{20,}"), "REDACTED_SQUARE"),
    (re.compile(r"key-[0-9a-f]{32}"), "REDACTED_MAILGUN"),
    (re.compile(r"npm_[A-Za-z0-9]{36}"), "REDACTED_NPM_TOKEN"),
    (re.compile(r"dop_v1_[a-f0-9]{64}"), "REDACTED_DIGITALOCEAN"),
    (re.compile(r"shpat_[a-f0-9]{32}"), "REDACTED_SHOPIFY"),
    (re.compile(r"ya29\.[A-Za-z0-9_\-]+"), "REDACTED_GOOGLE_OAUTH"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "REDACTED_PRIVATE_KEY"),
    # OpenAI generic sk- (after sk-ant handled above)
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}"), "REDACTED_OPENAI_KEY"),
]


def main(dirs):
    changed = subs = bad = 0
    for d in dirs:
        for fp in glob.glob(os.path.join(d, "**", "*.json"), recursive=True):
            t = open(fp).read()
            n = 0
            for rx, repl in PATTERNS:
                t, c = rx.subn(repl, t)
                n += c
            if n:
                try:
                    json.loads(t)
                except Exception as e:
                    bad += 1
                    print(f"  PARSE-FAIL (skipped): {fp}: {e}")
                    continue
                open(fp, "w").write(t)
                changed += 1
                subs += n
    print(f"scrubbed {changed} files, {subs} substitutions, parse-fails={bad}")
    return bad


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: scrub-canary-secrets.py <dir> [<dir> ...]")
        sys.exit(2)
    sys.exit(1 if main(sys.argv[1:]) else 0)
