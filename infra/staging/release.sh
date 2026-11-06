#!/usr/bin/env bash
# Release on the staging host: migrate, then build and restart the containers.
# Migrations run first and are additive (expand → contract), so the old containers keep working
# while they run. Never `prisma migrate reset` here.
#
#   infra/staging/release.sh <git-tag-or-commit>
set -euo pipefail
ref="${1:?usage: release.sh <git ref>}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

git fetch --tags origin
git checkout --detach "$ref"

# MIGRATION_DATABASE_URL (owner role) comes from the same rendered env file.
set -a; . "$here/.env.staging"; set +a
docker run --rm -v "$repo":/repo -w /repo -e MIGRATION_DATABASE_URL node:24-alpine \
  sh -c "corepack enable && pnpm install --frozen-lockfile --filter @gym/db... && pnpm db:deploy"

docker compose -f "$here/compose.yml" --env-file "$here/.env.staging" up -d --build
docker compose -f "$here/compose.yml" ps
echo "released $ref ($(git rev-parse --short HEAD))"
