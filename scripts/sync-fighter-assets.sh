#!/usr/bin/env bash
set -Eeuo pipefail

RESOURCE_GROUP="${RESOURCE_GROUP:-rg-twilio-games}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-twiliogamesdata}"
FIGHTER_ASSET_CONTAINER="${FIGHTER_ASSET_CONTAINER:-fighter-build-assets}"

command -v az >/dev/null || { echo "Azure CLI is required." >&2; exit 1; }
node tools/verify-lfs-assets.mjs
asset_bundle=$(node tools/verify-lfs-assets.mjs --print-bundle-id)

staging_root=$(mktemp -d)
verification_root=$(mktemp -d)
trap 'rm -rf "$staging_root" "$verification_root"' EXIT
while IFS= read -r file; do
  destination="$staging_root/$file"
  mkdir -p "$(dirname "$destination")"
  cp "$PWD/$file" "$destination"
done < <(node tools/verify-lfs-assets.mjs --print-files)
node tools/verify-lfs-assets.mjs --asset-root "$staging_root" --exact

export AZURE_STORAGE_ACCOUNT="$STORAGE_ACCOUNT"
AZURE_STORAGE_KEY=$(az storage account keys list \
  --resource-group "$RESOURCE_GROUP" \
  --account-name "$STORAGE_ACCOUNT" \
  --query '[0].value' --output tsv)
export AZURE_STORAGE_KEY

az storage container create \
  --name "$FIGHTER_ASSET_CONTAINER" \
  --public-access off \
  --output none
az storage container set-permission \
  --name "$FIGHTER_ASSET_CONTAINER" \
  --public-access off \
  --output none
while IFS= read -r file; do
  blob="$asset_bundle/$file"
  exists=$(az storage blob exists \
    --container-name "$FIGHTER_ASSET_CONTAINER" \
    --name "$blob" \
    --query exists --output tsv)
  if [ "$exists" != "true" ]; then
    az storage blob upload \
      --container-name "$FIGHTER_ASSET_CONTAINER" \
      --name "$blob" \
      --file "$staging_root/$file" \
      --overwrite false \
      --if-none-match '*' \
      --validate-content \
      --no-progress \
      --output none
  fi
done < <(node tools/verify-lfs-assets.mjs --print-files)

while IFS= read -r file; do
  destination="$verification_root/$asset_bundle/$file"
  mkdir -p "$(dirname "$destination")"
  az storage blob download \
    --container-name "$FIGHTER_ASSET_CONTAINER" \
    --name "$asset_bundle/$file" \
    --file "$destination" \
    --overwrite true \
    --no-progress \
    --output none
done < <(node tools/verify-lfs-assets.mjs --print-files)
node tools/verify-lfs-assets.mjs --asset-root "$verification_root/$asset_bundle" --exact
