#!/usr/bin/env bash
# Writes infra/staging/.env.staging from one Secrets Manager secret (a JSON object of KEY: value).
# Run on the EC2 host; its instance role needs secretsmanager:GetSecretValue on this secret only.
#
#   infra/staging/render-env.sh gym-saas/staging
set -euo pipefail
secret_id="${1:?usage: render-env.sh <secret-id>}"
out="$(dirname "$0")/.env.staging"
umask 077
aws secretsmanager get-secret-value --secret-id "$secret_id" --query SecretString --output text \
  | jq -r 'to_entries[] | "\(.key)=\(.value | tostring | @json)"' > "$out"
# Never echo the values.
echo "wrote $(wc -l < "$out") settings to $out"
