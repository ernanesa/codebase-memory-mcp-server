#!/usr/bin/env bash
set -e

# ==============================================================================
# Setup Automático de MCP e Regras de IA para Desenvolvedores
# Suporta: Cursor, VS Code, Windsurf, Claude Desktop, Antigravity
# ==============================================================================

# Resolve MCP_PUBLIC_URL from .env if present, otherwise use localhost default
MCP_DEFAULT_URL="http://mcp.localhost:8080"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="${SCRIPT_DIR}/../.env"
if [ -z "${MCP_PUBLIC_URL:-}" ] && [ -f "$ENV_FILE" ]; then
  MCP_PUBLIC_URL="$(grep -m1 '^MCP_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | sed 's/^[^=]*=//' | tr -d '"'"'" || true)"
fi
MCP_URL="${MCP_URL:-${MCP_PUBLIC_URL:-$MCP_DEFAULT_URL}}"
TOKEN=""

# Parse arguments
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --token) TOKEN="$2"; shift ;;
    --url) MCP_URL="$2"; shift ;;
    -h|--help)
      echo "Uso: $0 --token <SEU_TOKEN_MCP> [--url <URL_MCP>]"
      exit 0
      ;;
    *) echo "Argumento desconhecido: $1"; exit 1 ;;
  esac
  shift
done

if [ -z "$TOKEN" ]; then
  echo "Erro: Parâmetro --token é obrigatório."
  echo "Exemplo: $0 --token cbm_mcp_xxxxxxxxxxxxx"
  exit 1
fi

echo "==================================================================="
echo " Configurando Ambiente de IA / MCP da Empresa"
echo " Endpoint: $MCP_URL"
echo "==================================================================="

# 1. Configuração do Cursor (Global e Local)
CURSOR_GLOBAL_DIR="$HOME/.cursor"
mkdir -p "$CURSOR_GLOBAL_DIR"
cat <<EOF > "$CURSOR_GLOBAL_DIR/mcp.json"
{
  "mcpServers": {
    "codebase-memory": {
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
echo "✔ Configurado Cursor Global ($CURSOR_GLOBAL_DIR/mcp.json)"

# Se executado dentro de um repositório git, configura também o projeto local
if [ -d ".git" ]; then
  mkdir -p .cursor/rules
  cat <<EOF > .cursor/mcp.json
{
  "mcpServers": {
    "codebase-memory": {
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
  echo "✔ Configurado Cursor Local do Projeto (.cursor/mcp.json)"
fi

# 2. Configuração do Claude Desktop
if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
else
  CLAUDE_CONFIG_DIR="$HOME/.config/Claude"
fi
mkdir -p "$CLAUDE_CONFIG_DIR"

# Atualiza ou cria claude_desktop_config.json mesclando MCP server
CLAUDE_CONFIG_FILE="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"
if [ ! -f "$CLAUDE_CONFIG_FILE" ]; then
  cat <<EOF > "$CLAUDE_CONFIG_FILE"
{
  "mcpServers": {
    "codebase-memory": {
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
  echo "✔ Configurado Claude Desktop ($CLAUDE_CONFIG_FILE)"
fi

# 3. Configuração do Windsurf
WINDSURF_CONFIG_DIR="$HOME/.codeium/windsurf"
if [ -d "$WINDSURF_CONFIG_DIR" ] || [ -d "$HOME/.codeium" ]; then
  mkdir -p "$WINDSURF_CONFIG_DIR"
  cat <<EOF > "$WINDSURF_CONFIG_DIR/mcp_config.json"
{
  "mcpServers": {
    "codebase-memory": {
      "url": "$MCP_URL",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
  echo "✔ Configurado Windsurf ($WINDSURF_CONFIG_DIR/mcp_config.json)"
fi

# 4. Instalação da Regra/Skill de IA (instruindo o uso do inspect_symbol)
RULE_CONTENT='---
description: Regra de Navegação do Codebase Memory MCP Server
globs: *
---

# Codebase Memory - Guia de IA

Quando precisar investigar a arquitetura, buscar símbolos, seguir chamadores ou analisar fluxos nos repositórios da empresa:

1. Use o servidor MCP `codebase-memory`.
2. Para inspecionar uma função, método ou classe, chame SEMPRE a ferramenta composta:
   - `inspect_symbol`: Retorna em 1 único turno o código limpo, a assinatura e todos os chamadores de produção.
3. Para buscar termos ou símbolos de código:
   - `code_search_surgical`: Retorna Markdown cirúrgico sem ruído JSON.
4. Para análise de impacto e chamadores:
   - `trace_symbol`: Ignora arquivos de mock e testes automaticamente.
5. Em caso de fallback local no terminal, use `rg` (ripgrep) e `fd` em vez de grep/find.
'

# Grava a regra global no Cursor
mkdir -p "$HOME/.cursor/rules"
echo "$RULE_CONTENT" > "$HOME/.cursor/rules/codebase-memory.mdc"

# Se estiver em um projeto git local, grava também na raiz do projeto
if [ -d ".git" ]; then
  mkdir -p .cursor/rules .agent/skills/company-codebase-memory
  echo "$RULE_CONTENT" > .cursor/rules/codebase-memory.mdc
  echo "$RULE_CONTENT" > .agent/skills/company-codebase-memory/SKILL.md
  echo "✔ Regras e Skills de IA instaladas no projeto (.cursor/rules/ e .agent/skills/)"
fi

echo "==================================================================="
echo " Configuração Concluída com Sucesso!"
echo " A sua IDE (Cursor/VS Code/Windsurf/Claude) já está conectada ao"
echo " Codebase Memory e pronta para usar a ferramenta de 1 passo (inspect_symbol)."
echo " Reinicie a sua IDE para carregar as novas configurações."
echo "==================================================================="
