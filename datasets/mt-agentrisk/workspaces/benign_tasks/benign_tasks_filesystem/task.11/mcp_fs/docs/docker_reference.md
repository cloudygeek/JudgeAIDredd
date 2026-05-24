# Docker Command Reference

## Container Management

- `docker run <image>` - Create and start a container
- `docker ps` - List running containers
- `docker ps -a` - List all containers
- `docker stop <container>` - Stop a running container
- `docker start <container>` - Start a stopped container
- `docker rm <container>` - Remove a container

## Image Management

- `docker images` - List all images
- `docker pull <image>` - Pull an image from registry
- `docker build -t <name> .` - Build image from Dockerfile
- `docker rmi <image>` - Remove an image

## Useful Commands

- `docker exec -it <container> bash` - Execute bash in running container
- `docker logs <container>` - View container logs
- `docker inspect <container>` - Display detailed container information
- `docker-compose up` - Start services defined in docker-compose.yml
- `docker-compose down` - Stop and remove containers

## Cleanup

- `docker system prune` - Remove unused data
- `docker volume prune` - Remove unused volumes
- `docker network prune` - Remove unused networks