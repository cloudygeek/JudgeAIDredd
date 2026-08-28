# Decommissioned 2026-08-28 — AWS compute tier

These .tf files describe the Fargate/ALB stack destroyed on 2026-08-28
(targeted `tofu destroy`, 39 resources) after the move to the self-hosted
Studio deployment (`selfhost/`). They are parked here — OpenTofu ignores
subdirectories — so a plain `tofu apply` in the parent can never
resurrect the stack by accident.

Destroyed: ALB + listeners + rules + target groups, ECS cluster/services/
task definitions (the cluster had already been deleted out-of-band), ECR
repos (images were emptied first — rebuild from source), task/exec IAM,
Clerk Secrets Manager entries, `dredd-hook.acta.io` / `dredd.acta.io`
Route53 records + ACM cert, ALB/task security groups, the extra ALB
subnet.

KEPT in the parent module (in active use by the Studio stack): the five
`jaid-*` DynamoDB tables, the BYOT KMS key (existing `jaid-byot`
ciphertexts are undecryptable without it), both CloudWatch log groups,
and the ALB access-log S3 bucket (operator kept all logs).

To resurrect: move these files back into `terraform/`, restore the
pruned `alb_*` locals in `variables.tf` and the outputs in `outputs.tf`
(see git history at this commit), delete `decommission-keeps.tf` (it
re-declares the two data sources iam.tf owned), then `tofu plan`.
