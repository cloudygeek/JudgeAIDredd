// Route53 A-records pointing the two hosts at the ALB. ACM validation
// records are in acm.tf.

resource "aws_route53_record" "hook" {
  zone_id = var.route53_zone_id
  name    = var.hook_host
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "dashboard" {
  zone_id = var.route53_zone_id
  name    = var.dashboard_host
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
