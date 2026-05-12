terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }

  // Remote state in the acta-terraform bucket. Native S3 locking
  // (use_lockfile) avoids needing a separate DynamoDB lock table.
  // Override the key per environment if you stand up more than one
  // stack — e.g. `-backend-config="key=judgeaidredd/staging/terraform.tfstate"`.
  backend "s3" {
    bucket       = "acta-terraform"
    key          = "judgeaidredd/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.primary_region
  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
      Repo        = "cloudygeek/JudgeAIDredd"
    }
  }
}
