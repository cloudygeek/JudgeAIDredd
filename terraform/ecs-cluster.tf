// Fargate cluster. Two capacity providers (FARGATE + FARGATE_SPOT) so
// you can flip non-prod environments onto Spot via the strategy in the
// service definition. Default strategy is 100% FARGATE — the hook is on
// the request hot path and shouldn't be on Spot in prod.
resource "aws_ecs_cluster" "main" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}
