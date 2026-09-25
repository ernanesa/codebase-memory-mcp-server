#!/usr/bin/env python3
import os
import sys
import json
import yaml
from pathlib import Path

CONFIG_PATH = Path('data/agentgateway/config.yaml')

def _read_env_file(env_path='.env'):
    """Lê variáveis de um arquivo .env simples (KEY=VALUE por linha)."""
    result = {}
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                result[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return result

_env = _read_env_file()
MCP_URL = os.environ.get('MCP_PUBLIC_URL') or _env.get('MCP_PUBLIC_URL') or 'http://mcp.localhost:8080'

if not CONFIG_PATH.exists():
    print(f"Erro: Arquivo {CONFIG_PATH} não encontrado.", file=sys.stderr)
    sys.exit(1)

with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
    cfg = yaml.safe_load(f)

keys = cfg.get('mcp', {}).get('policies', {}).get('apiKey', {}).get('keys', [])

filter_email = None
filter_workspace = None

args = sys.argv[1:]
i = 0
while i < len(args):
    if args[i] == '--email' and i + 1 < len(args):
        filter_email = args[i + 1].lower()
        i += 1
    elif args[i] == '--workspace' and i + 1 < len(args):
        filter_workspace = args[i + 1].lower()
        i += 1
    i += 1

def generate_mcp_json(token):
    return {
        "mcpServers": {
            "codebase-memory": {
                "url": MCP_URL,
                "headers": {
                    "Authorization": f"Bearer {token}"
                }
            }
        }
    }

print("=" * 70)
print(" CONFIGURAÇÃO AUTOMÁTICA DE MCP PARA DESENVOLVEDORES")
print(f" Endpoint: {MCP_URL}")
print("=" * 70)

found = 0
for entry in keys:
    meta = entry.get('metadata', {})
    email = (meta.get('identity') or '').lower()
    user_name = meta.get('user') or 'Desconhecido'
    access = meta.get('access') or ''
    workspace_id = meta.get('workspaceId') or ''
    token = entry.get('key')

    if filter_email and filter_email not in email:
        continue
    if filter_workspace and filter_workspace != workspace_id.lower():
        continue

    found += 1
    print(f"\n▶ [{access.upper()}] {user_name} ({email})")
    print(f"Token: {token}")
    print("\nArquivo de Configuração para Cursor / VS Code (.cursor/mcp.json):")
    print(json.dumps(generate_mcp_json(token), indent=2))
    print("\nComando de 1 linha para o dev executar no terminal dele:")
    print(f"  ./scripts/setup-developer-ide.sh --token \"{token}\"")
    print("-" * 70)

if found == 0:
    print("\nNenhum usuário ou workspace encontrado com os filtros informados.")
