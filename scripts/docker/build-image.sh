#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${OPENCLAW_IMAGE:-}"
IMAGE_REPO="${OPENCLAW_IMAGE_REPO:-}"
DOCKERFILE_PATH="${OPENCLAW_DOCKERFILE:-$ROOT_DIR/Dockerfile}"
BUILD_CONTEXT="${OPENCLAW_DOCKER_CONTEXT:-$ROOT_DIR}"
BUILD_TARGET="${OPENCLAW_DOCKER_TARGET:-}"
BUILD_PLATFORMS="${OPENCLAW_DOCKER_PLATFORMS:-}"
EXTRA_TAGS_RAW="${OPENCLAW_DOCKER_EXTRA_TAGS:-}"
PUSH_RAW="${OPENCLAW_DOCKER_PUSH:-}"
LOAD_RAW="${OPENCLAW_DOCKER_LOAD:-}"
NO_CACHE_RAW="${OPENCLAW_DOCKER_NO_CACHE:-}"
TAG_FROM_GIT_RAW="${OPENCLAW_DOCKER_TAG_FROM_GIT:-}"

usage() {
  cat <<EOF
Usage: ./scripts/docker/build-image.sh

Build the OpenClaw Docker image without onboarding, token generation, compose
setup, or local gateway configuration. This is meant for image publishing flows
such as GHCR + Kubernetes.

Environment:
  OPENCLAW_IMAGE                 Explicit image ref (default: openclaw:local)
  OPENCLAW_IMAGE_REPO            Repo base for generated git tags (for example ghcr.io/me/openclaw)
  OPENCLAW_DOCKER_EXTRA_TAGS     Extra image tags (comma-separated)
  OPENCLAW_DOCKERFILE            Dockerfile path (default: $ROOT_DIR/Dockerfile)
  OPENCLAW_DOCKER_CONTEXT        Docker build context (default: $ROOT_DIR)
  OPENCLAW_DOCKER_TARGET         Optional docker build --target
  OPENCLAW_DOCKER_PLATFORMS      Optional buildx --platform list
  OPENCLAW_DOCKER_PUSH           Use docker buildx build --push
  OPENCLAW_DOCKER_LOAD           Use docker buildx build --load
  OPENCLAW_DOCKER_NO_CACHE       Add --no-cache
  OPENCLAW_DOCKER_TAG_FROM_GIT   Generate <branch>-<shortsha> tag from the current git checkout

Forwarded build args when set:
  OPENCLAW_EXTENSIONS
  OPENCLAW_VARIANT
  OPENCLAW_DOCKER_APT_UPGRADE
  OPENCLAW_DOCKER_APT_PACKAGES
  OPENCLAW_INSTALL_BROWSER
  OPENCLAW_INSTALL_DOCKER_CLI
  OPENCLAW_INSTALL_CODEX_CLI
  OPENCLAW_CODEX_VERSION
  OPENCLAW_INSTALL_GOG_CLI
  OPENCLAW_GOG_CLI_VERSION
  OPENCLAW_INSTALL_GOPLACES
  OPENCLAW_GOPLACES_VERSION
  OPENCLAW_DOCKER_GPG_FINGERPRINT
  OPENCLAW_NODE_BOOKWORM_IMAGE
  OPENCLAW_NODE_BOOKWORM_DIGEST
  OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE
  OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

is_truthy_value() {
  local raw="${1:-}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

contains_disallowed_chars() {
  local value="$1"
  [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *$'\t'* ]]
}

trim_ascii_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

sanitize_docker_tag_part() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g')"
  value="$(trim_ascii_whitespace "$value")"
  if [[ -z "$value" ]]; then
    value="detached"
  fi
  printf '%s' "$value"
}

validate_single_line_value() {
  local label="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    fail "$label cannot be empty."
  fi
  if contains_disallowed_chars "$value"; then
    fail "$label contains unsupported control characters."
  fi
  if [[ "$value" =~ [[:space:]] ]]; then
    fail "$label cannot contain whitespace."
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  fail "Unexpected arguments: $*"
fi

require_cmd docker

if [[ -n "$IMAGE_NAME" && -n "$IMAGE_REPO" ]]; then
  fail "Set either OPENCLAW_IMAGE or OPENCLAW_IMAGE_REPO, not both."
fi

if [[ ! -f "$DOCKERFILE_PATH" ]]; then
  fail "Dockerfile not found: $DOCKERFILE_PATH"
fi
if [[ ! -d "$BUILD_CONTEXT" ]]; then
  fail "Docker build context not found: $BUILD_CONTEXT"
fi

if [[ -n "$BUILD_TARGET" ]]; then
  validate_single_line_value "OPENCLAW_DOCKER_TARGET" "$BUILD_TARGET"
fi
if [[ -n "$BUILD_PLATFORMS" ]]; then
  validate_single_line_value "OPENCLAW_DOCKER_PLATFORMS" "$BUILD_PLATFORMS"
fi

PUSH_ENABLED=""
LOAD_ENABLED=""
NO_CACHE_ENABLED=""
TAG_FROM_GIT_ENABLED=""
if is_truthy_value "$PUSH_RAW"; then
  PUSH_ENABLED="1"
fi
if is_truthy_value "$LOAD_RAW"; then
  LOAD_ENABLED="1"
fi
if is_truthy_value "$NO_CACHE_RAW"; then
  NO_CACHE_ENABLED="1"
fi
if is_truthy_value "$TAG_FROM_GIT_RAW"; then
  TAG_FROM_GIT_ENABLED="1"
fi

if [[ -n "$PUSH_ENABLED" && -n "$LOAD_ENABLED" ]]; then
  fail "OPENCLAW_DOCKER_PUSH and OPENCLAW_DOCKER_LOAD cannot both be enabled."
fi

GENERATED_GIT_TAG=""
if [[ -n "$TAG_FROM_GIT_ENABLED" ]]; then
  require_cmd git
  if ! git -C "$ROOT_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
    fail "OPENCLAW_DOCKER_TAG_FROM_GIT requires the repo root to be a git checkout."
  fi
  branch_name="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || true)"
  branch_name="$(trim_ascii_whitespace "$branch_name")"
  if [[ -z "$branch_name" ]]; then
    branch_name="detached"
  fi
  branch_name="$(sanitize_docker_tag_part "$branch_name")"
  commit_short="$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || true)"
  commit_short="$(trim_ascii_whitespace "$commit_short")"
  if [[ -z "$commit_short" ]]; then
    fail "OPENCLAW_DOCKER_TAG_FROM_GIT could not resolve HEAD."
  fi
  GENERATED_GIT_TAG="${branch_name}-${commit_short}"
  if [[ -z "$IMAGE_REPO" ]]; then
    fail "OPENCLAW_DOCKER_TAG_FROM_GIT requires OPENCLAW_IMAGE_REPO so the generated tag has a registry/repo target."
  fi
  IMAGE_NAME="${IMAGE_REPO}:${GENERATED_GIT_TAG}"
elif [[ -n "$IMAGE_REPO" ]]; then
  fail "OPENCLAW_IMAGE_REPO is only used with OPENCLAW_DOCKER_TAG_FROM_GIT=1."
fi

IMAGE_NAME="${IMAGE_NAME:-openclaw:local}"
validate_single_line_value "OPENCLAW_IMAGE" "$IMAGE_NAME"

EXTRA_TAGS=()
if [[ -n "$EXTRA_TAGS_RAW" ]]; then
  IFS=',' read -r -a raw_tags <<<"$EXTRA_TAGS_RAW"
  for raw_tag in "${raw_tags[@]}"; do
    tag="$(trim_ascii_whitespace "$raw_tag")"
    if [[ -z "$tag" ]]; then
      continue
    fi
    validate_single_line_value "OPENCLAW_DOCKER_EXTRA_TAGS entry" "$tag"
    EXTRA_TAGS+=("$tag")
  done
fi

BUILD_CMD=(docker build)
if [[ -n "$BUILD_PLATFORMS" || -n "$PUSH_ENABLED" || -n "$LOAD_ENABLED" ]]; then
  if ! docker buildx version >/dev/null 2>&1; then
    fail "Docker Buildx is required for OPENCLAW_DOCKER_PLATFORMS, OPENCLAW_DOCKER_PUSH, or OPENCLAW_DOCKER_LOAD."
  fi
  BUILD_CMD=(docker buildx build)
fi

if [[ -n "$BUILD_PLATFORMS" ]]; then
  BUILD_CMD+=(--platform "$BUILD_PLATFORMS")
fi
if [[ -n "$NO_CACHE_ENABLED" ]]; then
  BUILD_CMD+=(--no-cache)
fi
if [[ -n "$BUILD_TARGET" ]]; then
  BUILD_CMD+=(--target "$BUILD_TARGET")
fi
if [[ -n "$PUSH_ENABLED" ]]; then
  BUILD_CMD+=(--push)
elif [[ -n "$LOAD_ENABLED" ]]; then
  BUILD_CMD+=(--load)
elif [[ -n "$BUILD_PLATFORMS" ]]; then
  if [[ "$BUILD_PLATFORMS" == *,* ]]; then
    fail "OPENCLAW_DOCKER_PLATFORMS with multiple platforms requires OPENCLAW_DOCKER_PUSH=1."
  fi
  BUILD_CMD+=(--load)
fi

BUILD_CMD+=(-t "$IMAGE_NAME")
for tag in "${EXTRA_TAGS[@]}"; do
  BUILD_CMD+=(-t "$tag")
done

FORWARDED_BUILD_ARGS=(
  OPENCLAW_EXTENSIONS
  OPENCLAW_VARIANT
  OPENCLAW_DOCKER_APT_UPGRADE
  OPENCLAW_DOCKER_APT_PACKAGES
  OPENCLAW_INSTALL_BROWSER
  OPENCLAW_INSTALL_DOCKER_CLI
  OPENCLAW_INSTALL_CODEX_CLI
  OPENCLAW_CODEX_VERSION
  OPENCLAW_INSTALL_GOG_CLI
  OPENCLAW_GOG_CLI_VERSION
  OPENCLAW_INSTALL_GOPLACES
  OPENCLAW_GOPLACES_VERSION
  OPENCLAW_DOCKER_GPG_FINGERPRINT
  OPENCLAW_NODE_BOOKWORM_IMAGE
  OPENCLAW_NODE_BOOKWORM_DIGEST
  OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE
  OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
)

for arg_name in "${FORWARDED_BUILD_ARGS[@]}"; do
  if [[ -n "${!arg_name+x}" ]]; then
    BUILD_CMD+=(--build-arg "$arg_name=${!arg_name}")
  fi
done

BUILD_CMD+=(-f "$DOCKERFILE_PATH" "$BUILD_CONTEXT")

echo "==> Building image: $IMAGE_NAME"
if [[ -n "$GENERATED_GIT_TAG" ]]; then
  echo "Generated image tag: $GENERATED_GIT_TAG"
fi
echo "Dockerfile: $DOCKERFILE_PATH"
echo "Context: $BUILD_CONTEXT"
if [[ -n "$BUILD_PLATFORMS" ]]; then
  echo "Platforms: $BUILD_PLATFORMS"
fi
if [[ -n "$BUILD_TARGET" ]]; then
  echo "Target: $BUILD_TARGET"
fi
if [[ -n "$PUSH_ENABLED" ]]; then
  echo "Output: push"
elif [[ -n "$LOAD_ENABLED" || -n "$BUILD_PLATFORMS" ]]; then
  echo "Output: load"
fi

"${BUILD_CMD[@]}"
