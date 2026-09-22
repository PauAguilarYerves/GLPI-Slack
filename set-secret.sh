#!/usr/bin/env bash
# Guarda un valor secreto en .env sin que aparezca en pantalla ni en el historial.
#   ./set-secret.sh GLPI_APP_TOKEN
set -euo pipefail
cd "$(dirname "$0")"

VAR="${1:-}"
if [ -z "$VAR" ]; then
  echo "Uso: ./set-secret.sh NOMBRE_DE_LA_VARIABLE"
  echo "Ej:  ./set-secret.sh SLACK_BOT_TOKEN"
  exit 1
fi
[ -f .env ] || cp .env.example .env

printf 'Pega el valor de %s (no se mostrara): ' "$VAR"
read -rs VALUE || true
echo

# Limpieza y comprobaciones: los pegados arrastran retornos de carro y espacios,
# y de vez en cuando lo que se pega no es el token sino una URL.
VALUE="$(printf '%s' "$VALUE" | tr -d '\r\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

if [ -z "$VALUE" ]; then
  echo "  Valor vacio, no se ha guardado nada."
  exit 1
fi
case "$VALUE" in
  http://*|https://*|*/*|*\?*)
    echo "  Eso parece una URL, no un token. No se ha guardado nada."
    exit 1;;
esac
if printf '%s' "$VALUE" | grep -q '[[:space:]]'; then
  echo "  El valor contiene espacios. No se ha guardado nada."
  exit 1
fi

VAR="$VAR" VALUE="$VALUE" python3 - <<'PY'
import os, re
var, value = os.environ['VAR'], os.environ['VALUE']
path = '.env'
lines = open(path).read().splitlines(keepends=True)
pattern = re.compile(rf'^{re.escape(var)}=')
found = False
for i, line in enumerate(lines):
    if pattern.match(line):
        # Conserva el comentario que hubiera al final de la linea.
        lines[i] = f'{var}={value}\n'
        found = True
        break
if not found:
    lines.append(f'{var}={value}\n')
open(path, 'w').write(''.join(lines))
print(f'  {var} guardado ({len(value)} caracteres)')
PY
unset VALUE
chmod 600 .env
