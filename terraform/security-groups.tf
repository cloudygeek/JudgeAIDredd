// ALB security group — public-internet ingress on 443 (and 80 for redirect).
resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "ALB ingress 80/443 from the internet"
  vpc_id      = var.existing_vpc_id

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP (redirect to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Any outbound (ALB to tasks)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-alb"
  }
}

// Task security group — only the ALB can reach the app port.
resource "aws_security_group" "task" {
  name        = "${local.name_prefix}-task"
  description = "Fargate tasks; ingress from ALB on port 3000"
  vpc_id      = var.existing_vpc_id

  ingress {
    description     = "ALB to task"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  // Egress to anywhere via NAT: Bedrock (eu-west-2), DynamoDB, Clerk
  // JWKS, ECR, CloudWatch logs, Secrets Manager. AWS endpoints are all
  // 443; Bedrock and Clerk are 443. No need to lock down further.
  egress {
    description = "Outbound to AWS services + Clerk"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name_prefix}-task"
  }
}
