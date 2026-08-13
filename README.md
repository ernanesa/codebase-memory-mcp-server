# Codebase Memory MCP Server

Ambiente autogerenciado para disponibilizar repositórios a clientes MCP e manter Knowledge Bases corporativas com Open WebUI, Ollama, Docling e Google Drive.

## Recursos

- painel para workspaces, repositórios, indexação e sincronização Git;
- endpoint MCP remoto protegido por tokens de workspace ou usuário;
- controle de acesso por repositório;
- Open WebUI com chat e RAG híbrido;
- embeddings multilíngues com `bge-m3` e reranking;
- extração de documentos, OCR adaptativo e tabelas com Docling em CPU;
- sincronização incremental de pastas do Drive e links HTTPS → Knowledge Base por cron;
- citações do Drive abrem diretamente o arquivo original, respeitando a conta Google e as permissões do usuário;
- `kb_exec` expõe IDs e caminhos canônicos e tolera caminhos abreviados não ambíguos;
- reprocessamento seletivo, histórico por arquivo e detecção incremental via Drive Changes API;
- health detalhado, métricas Prometheus e Grafana instalados por padrão;
- runner versionável para avaliação do RAG documental;
- Ollama em Docker no Linux ou nativo no macOS.

## Requisitos

- Debian, Ubuntu ou distribuição compatível com `apt-get`; ou macOS 14+;
- usuário comum com acesso a `sudo`;
- Docker e Docker Compose, instalados automaticamente quando necessário;
- acesso de leitura aos repositórios GitHub;
- GPU NVIDIA opcional para o Ollama no Linux.

Não execute o instalador diretamente como `root`.

## Instalação

```bash
git clone git@github.com:pauloricardo-ggs/codebase-memory-mcp-server.git
cd codebase-memory-mcp-server
chmod +x install.sh
./install.sh
```

O instalador conduz uma configuração guiada em seis etapas, sempre exibindo o
valor padrão ou a configuração atual:

- orçamento de memória do Codebase Memory;
- runtime e modelo do Ollama;
- aceleração NVIDIA, quando disponível;
- e-mail e senha administrativos;
- quatro origens públicas, uma para cada serviço exposto.

Antes de aplicar alterações, ele apresenta uma revisão completa e solicita a
confirmação. A instalação é dividida em quatro fases visíveis: dependências,
configuração local, serviços e verificações finais. Ao concluir, o resumo reúne
os endereços de acesso e os próximos passos.

O instalador cria `.env`, prepara diretórios e segredos, constrói os serviços,
baixa o modelo de chat e o `bge-m3`, configura presets do Open WebUI e valida o
endpoint MCP. Reinstalações preservam dados e configurações válidas.

O Google Drive é configurado depois da instalação, pelo painel. Consulte [Configurar Google Drive](GOOGLE-DRIVE-CONFIG.md).

## Endereços padrão

| Serviço | Endereço |
| --- | --- |
| Open WebUI | `http://openwebui.localhost:8080/` |
| Painel administrativo | `http://admin.localhost:8080/` |
| Endpoint MCP | `http://mcp.localhost:8080/` |
| Grafana | `http://grafana.localhost:8080/` |

O Open WebUI e o Grafana usam seus próprios logins. O dashboard do Grafana também fica incorporado na área **Observabilidade** do painel administrativo; na primeira abertura, pode ser necessário autenticar-se no próprio Grafana. O painel administrativo possui sessão JWT própria e o endpoint MCP usa tokens individuais. A porta do proxy é vinculada somente a `127.0.0.1`; Prometheus e os demais backends permanecem na rede Docker.
O histórico da área **Operações** é persistido por sete dias em `data/jobs.json`, sobrevive à reinstalação e é exibido em páginas de dez registros.
O dashboard provisionado **Codebase Memory — Operação** é aberto como página inicial e acompanha saúde, sincronizações, arquivos, jobs, erros externos, latência e memória.

## Primeiro uso

1. Acesse o painel administrativo.
2. Conecte um token fine-grained do GitHub.
3. Crie um workspace e adicione repositórios.
4. Aguarde os clones e inicie a primeira indexação.
5. Crie acessos MCP por workspace ou por desenvolvedor.
6. No Open WebUI, envie documentos ou configure pastas do Drive.

O token GitHub precisa de leitura de metadados e, para repositórios privados, leitura de conteúdo. Restrinja-o à organização e aos repositórios necessários.

## Conectar um cliente MCP

O endpoint usa Streamable HTTP e Bearer token:

```text
https://<host-mcp>/
```

Exemplo para Codex em `~/.codex/config.toml`:

```toml
[mcp_servers.codebase_memory]
enabled = true
startup_timeout_sec = 30
tool_timeout_sec = 120
url = "https://<host-mcp>/"

[mcp_servers.codebase_memory.http_headers]
Authorization = "Bearer <SEU_TOKEN>"
```

Guarde tokens em variáveis de ambiente ou armazenamento seguro. Não os versione.

## Como os documentos são processados

```text
Upload, Google Drive ou links HTTPS
        ↓
Open WebUI → Docling CPU → Markdown estruturado
        ↓
Ollama/bge-m3 → busca híbrida → reranker → chat
```

O Docling usa OCR somente onde necessário (`do_ocr=true`, `force_ocr=false`), mantém tabelas em modo preciso e não possui volume próprio. Seus modelos vêm na imagem; documentos, chunks e vetores persistem no Open WebUI.

A sincronização de fontes usa cron por Knowledge Base. O padrão `30 * * * *` verifica mudanças no minuto 30 de cada hora. Bases vencidas entram em uma fila sequencial para limitar o consumo de recursos. Links públicos são coletados sem crawling ou JavaScript, com descrição opcional incluída nos embeddings.

## Documentação

- [Arquitetura e operação técnica](ARCHITECTURE.md)
- [Configuração e manutenção](CONFIGURATION.md)
- [Configurar Google Drive](GOOGLE-DRIVE-CONFIG.md)
- [Avaliar a qualidade do RAG](RAG-EVALUATION.md)
- [Skill Company Codebase Memory](skills/company-codebase-memory/)

## Segurança

- não exponha o ambiente diretamente à internet sem HTTPS e controles de rede;
- mantenha a porta do proxy vinculada ao loopback e publique somente os quatro hostnames pelo túnel;
- restrinja as portas do Ollama quando ele rodar no host macOS;
- use tokens individuais para escopos menores que um workspace;
- mantenha `data/`, `.env`, chaves e tokens fora do Git;
- restrinja a Service Account do Drive a leitura das pastas necessárias;
- preserve `data/secrets/mcp-workspace-encryption-key` nos backups.

Em produção com Cloudflare Tunnel no host, configure os quatro hostnames com a mesma origem HTTP `http://127.0.0.1:8080` e não sobrescreva o **HTTP Host Header**. O TLS público termina na Cloudflare; nenhuma porta de entrada precisa ser aberta para o proxy.
