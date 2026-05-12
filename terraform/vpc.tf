// Networking — reuses the existing cloudRisk VPC.
//
// We do NOT create the VPC, IGW, NAT gateway, or main route tables —
// those are owned by the cloudRisk project and already provisioned.
// All we add is ONE extra public subnet in a second AZ, because the
// ALB requires subnets in ≥2 AZs and cloudRisk only ships one public
// subnet (eu-west-1a). Skipped entirely when alb_internet_facing=false.
//
// The new subnet associates with cloudRisk's existing public route
// table so it inherits the IGW route.

resource "aws_subnet" "alb_extra" {
  count = var.alb_internet_facing ? 1 : 0

  vpc_id                  = var.existing_vpc_id
  cidr_block              = var.new_public_subnet_cidr
  availability_zone       = var.new_public_subnet_az
  map_public_ip_on_launch = false // ALB ENI gets its own EIP-equivalent

  tags = {
    Name = "${local.name_prefix}-alb-${var.new_public_subnet_az}"
    Tier = "public"
  }
}

resource "aws_route_table_association" "alb_extra" {
  count = var.alb_internet_facing ? 1 : 0

  subnet_id      = aws_subnet.alb_extra[0].id
  route_table_id = var.existing_public_route_table_id
}
