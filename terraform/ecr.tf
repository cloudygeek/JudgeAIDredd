// ECR repositories for the two container images.
//
// Lifecycle policy keeps the last 20 images; older ones expire so the
// repo doesn't grow forever. Tag a "release" image and pin task defs
// to a specific tag if you need long-term retention.

resource "aws_ecr_repository" "hook" {
  name                 = "${var.project}-hook"
  image_tag_mutability = var.ecr_image_tag_mutability

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_repository" "dashboard" {
  name                 = "${var.project}-dashboard"
  image_tag_mutability = var.ecr_image_tag_mutability

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

// Two-rule lifecycle:
//
//  1. Expire untagged images 3 days after the push that displaced
//     them. image_tag_mutability=MUTABLE means every redeploy
//     overwrites :latest and orphans the previous digest as
//     untagged — without this, untagged versions accumulate
//     indefinitely up to the count cap.
//  2. Hard cap at 20 images total (safety net for rapid same-day
//     deploys, mid-flight builds, etc.). ECR evaluates rules in
//     priority order and stops at the first match, but the count
//     rule is a backstop, not the primary mechanism.
//
// Net result: steady state ≈ the most recent deploy plus whatever
// landed in the last 3 days. Storage per repo settles around
// 2-4 images × ~220 MB rather than growing toward the 20-image cap.
locals {
  ecr_lifecycle_policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 3 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 3
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Hard cap: keep last 20 images of any kind"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "hook" {
  repository = aws_ecr_repository.hook.name
  policy     = local.ecr_lifecycle_policy
}

resource "aws_ecr_lifecycle_policy" "dashboard" {
  repository = aws_ecr_repository.dashboard.name
  policy     = local.ecr_lifecycle_policy
}
