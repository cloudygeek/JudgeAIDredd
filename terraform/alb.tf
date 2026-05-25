// Single ALB; HTTPS listener with host-based routing to the two target
// groups. The hook target group has sticky sessions enabled so a
// session_id keeps hitting the same task (keeps the LRU cache warm).
// The dashboard doesn't need stickiness — its reads are Dynamo-backed.

resource "aws_lb" "main" {
  name               = local.name_prefix
  load_balancer_type = "application"
  internal           = !var.alb_internet_facing
  security_groups    = [aws_security_group.alb.id]

  subnets = local.alb_subnet_ids

  // Per-request access logs (client IP, request line, latencies, status)
  // delivered to S3. See alb-access-logs.tf for the bucket + delivery
  // policy. The default X-Forwarded-For *append* mode is left in place —
  // src/server-core.ts getClientIp relies on the trailing (ALB-appended)
  // hop being trustworthy; don't switch to `preserve`/`remove` without
  // revisiting that.
  access_logs {
    bucket  = aws_s3_bucket.alb_logs.bucket
    prefix  = local.alb_logs_prefix
    enabled = true
  }

  // Deletion protection off so `terraform destroy` works for non-prod.
  // Flip to true for shared prod stacks.
  enable_deletion_protection = false

  // The bucket policy must exist before the ALB tries its delivery
  // preflight, or `tofu apply` fails with "Access Denied for bucket".
  depends_on = [aws_s3_bucket_policy.alb_logs]
}

resource "aws_lb_target_group" "hook" {
  name                 = "${local.name_prefix}-hook"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = var.existing_vpc_id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  stickiness {
    type            = "lb_cookie"
    enabled         = true
    cookie_duration = 86400 // 24h — long enough to outlast any single Claude Code session
  }
}

resource "aws_lb_target_group" "dashboard" {
  // Name capped at 32 chars; trim if local.name_prefix is long.
  name                 = "${local.name_prefix}-dash"
  port                 = 3000
  protocol             = "HTTP"
  vpc_id               = var.existing_vpc_id
  target_type          = "ip"
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/health"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }
}

// Port 80 -> 443 redirect.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  // Default action: requests for an unknown host get a clean 404 rather
  // than landing on whichever target group is first.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Unknown host"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "hook" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.hook.arn
  }

  condition {
    host_header {
      values = [var.hook_host]
    }
  }
}

resource "aws_lb_listener_rule" "dashboard" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }

  condition {
    host_header {
      values = [var.dashboard_host]
    }
  }
}
