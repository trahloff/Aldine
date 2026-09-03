#!/usr/bin/env bash
# Build the server + compiler images for linux/arm64 (Fargate/Graviton — must
# match cpu_architecture in ecs.tf), push them to ECR, and roll the ECS service.
#
# Usage: AWS_PROFILE=papyr ./push-images.sh [tag]     (tag defaults to "latest")
# Run `terraform apply` first so the ECR repos and ECS service exist.
set -euo pipefail

cd "$(dirname "$0")"
TAG="${1:-latest}"
# Region: env override → terraform.tfvars → default. Must match where terraform
# created the ECR repos, or `docker push` fails with 'repository does not exist'.
REGION="${AWS_REGION:-$( { [ -f terraform.tfvars ] && grep -E '^[[:space:]]*region[[:space:]]*=' terraform.tfvars | head -1 | sed -E 's/.*"([^"]+)".*/\1/'; } || true )}"
REGION="${REGION:-eu-central-1}"
PLATFORM="${PLATFORM:-linux/arm64}" # must match runtime_platform.cpu_architecture in ecs.tf
REPO_ROOT="$(cd "../.." && pwd)"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
SERVER_REPO="${REGISTRY}/papyr-server"
COMPILER_REPO="${REGISTRY}/papyr-compiler"

echo "→ Logging in to ECR (${REGISTRY})"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

# buildx builder that can cross-build amd64 on an arm64 machine
docker buildx inspect papyr-builder >/dev/null 2>&1 || docker buildx create --name papyr-builder --use
docker buildx use papyr-builder

echo "→ Building + pushing server image (${SERVER_REPO}:${TAG})"
docker buildx build --platform "${PLATFORM}" \
  -f "${REPO_ROOT}/apps/server/Dockerfile" \
  -t "${SERVER_REPO}:${TAG}" --push "${REPO_ROOT}"

echo "→ Building + pushing compiler image (${COMPILER_REPO}:${TAG}, scheme ${ALDINE_TEXLIVE_SCHEME:-full})"
docker buildx build --platform "${PLATFORM}" \
  --build-arg "TEXLIVE_SCHEME=${ALDINE_TEXLIVE_SCHEME:-full}" \
  -f "${REPO_ROOT}/apps/compiler/Dockerfile" \
  -t "${COMPILER_REPO}:${TAG}" --push "${REPO_ROOT}/apps/compiler"

echo "→ Forcing a new ECS deployment"
aws ecs update-service --cluster papyr --service papyr --force-new-deployment \
  --region "${REGION}" >/dev/null

echo "✓ Done. Watch rollout:"
echo "  aws ecs wait services-stable --cluster papyr --services papyr --region ${REGION}"
