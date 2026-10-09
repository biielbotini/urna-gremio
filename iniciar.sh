#!/usr/bin/env bash
# Inicia o servidor da urna (Linux / macOS)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "O Node.js não foi encontrado. Instale a versão LTS em https://nodejs.org e tente novamente."
  exit 1
fi
echo "Iniciando o servidor da urna... Não feche esta janela durante a votação."
node server.js
