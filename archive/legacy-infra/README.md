# Legacy benchmark infrastructure

These files are the **pre-AI-Sandbox** deployment path for the Test 7
cross-model benchmark (`fargate/tests/docker-entrypoint.sh`). They are **not**
used by anything today.

- `deploy.sh` — bash deployer that builds, pushes, and runs a one-off
  Fargate task in `eu-west-2` under the `judge-ai-dredd` ECS cluster.
  Hardcoded to an old bucket + IAM role naming scheme.
- `task-definition.json` — task def template for `judge-ai-dredd-test7`.
  Environment vars reference the pre-4.6 Claude model line.
- `iam-task-policy.json` — task role with broad Bedrock wildcards
  (`arn:aws:bedrock:eu-west-2:*:inference-profile/*`). The `*:` account
  field permits any inference profile the account can reach — fine
  historically for benchmarking but would be a review-fail for a
  production role. Do not copy this pattern.
- `iam-execution-policy.json` — Secrets Manager + CloudWatch Logs for
  the ECS execution role.

## Why it's here

Moved from `fargate/infra/` when the sandbox deployment migrated to
CKO's AI Sandbox platform (CodeBuild → ECR → platform-managed task
definitions). The sandbox's real IAM/task-def lives in CKO's platform
IaC, not in this repo.

## When to resurrect

If you ever need to run the original Test 7 cross-model benchmark from
a fresh AWS account: copy these files back to `fargate/infra/`, update
the account/region/bucket values, re-run `deploy.sh --setup`, and
re-scope the IAM policy to specific inference-profile ARNs first.
