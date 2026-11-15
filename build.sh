#!/usr/bin/env bash
# Сборка CDNViewer.wgt для Samsung Smart TV (Tizen).
#
#   ./build.sh                 — собрать dist/CDNViewer.wgt и dist/CDNViewer-src.zip
#
# Подпись (нужна для установки на телевизор), один из вариантов:
#   1) Сертификаты Samsung в виде .p12:
#        AUTHOR_P12=~/SamsungCertificate/tv/author.p12 AUTHOR_PASSWORD=*** \
#        DISTRIBUTOR_P12=~/SamsungCertificate/tv/distributor.p12 DISTRIBUTOR_PASSWORD=*** ./build.sh
#      (по умолчанию ищутся certs/author.p12 и certs/distributor.p12)
#   2) Профиль Tizen Studio:  TIZEN_PROFILE=имя_профиля ./build.sh   (нужна команда tizen в PATH)
# Без сертификатов собирается неподписанный WGT.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
NAME="CDNViewer"

AUTHOR_P12="${AUTHOR_P12:-$ROOT/certs/author.p12}"
DISTRIBUTOR_P12="${DISTRIBUTOR_P12:-$ROOT/certs/distributor.p12}"

command -v zip >/dev/null || { echo "Нужна утилита zip" >&2; exit 1; }

rm -rf "$BUILD"
mkdir -p "$BUILD/wgt" "$DIST"
cp -R "$APP/." "$BUILD/wgt/"
find "$BUILD/wgt" \( -name '.DS_Store' -o -name 'Thumbs.db' -o -name '*~' \) -delete
rm -f "$BUILD/wgt/author-signature.xml" "$BUILD/wgt"/signature*.xml

VERSION="$(sed -n 's/.*<widget[^>]* version="\([^"]*\)".*/\1/p' "$APP/config.xml" | head -n1)"
SIGNED="нет"

if [ -f "$AUTHOR_P12" ] && [ -f "$DISTRIBUTOR_P12" ]; then
  python3 "$ROOT/tools/sign_wgt.py" "$BUILD/wgt" \
    --author "$AUTHOR_P12" --author-pass "${AUTHOR_PASSWORD:-}" \
    --distributor "$DISTRIBUTOR_P12" --distributor-pass "${DISTRIBUTOR_PASSWORD:-}"
  SIGNED="да (p12)"
fi

rm -f "$DIST/$NAME.wgt"
if [ "$SIGNED" = "нет" ] && [ -n "${TIZEN_PROFILE:-}" ] && command -v tizen >/dev/null; then
  tizen package -t wgt -s "$TIZEN_PROFILE" -o "$BUILD/out" -- "$BUILD/wgt"
  mv "$(ls "$BUILD/out"/*.wgt | head -n1)" "$DIST/$NAME.wgt"
  SIGNED="да (профиль $TIZEN_PROFILE)"
else
  (cd "$BUILD/wgt" && zip -q -X -D -r "$DIST/$NAME.wgt" .)
fi

# Архив исходников
rm -f "$DIST/$NAME-src.zip"
(cd "$ROOT" && zip -q -X -r "$DIST/$NAME-src.zip" app tools build.sh remote-config.json .gitignore .github \
  -x '*.DS_Store')

echo "Версия:     $VERSION"
echo "WGT:        $DIST/$NAME.wgt"
echo "Исходники:  $DIST/$NAME-src.zip"
echo "Подписан:   $SIGNED"
if [ "$SIGNED" = "нет" ]; then
  echo "Для установки на ТВ подпишите сертификатом Samsung (см. начало build.sh)" >&2
fi
