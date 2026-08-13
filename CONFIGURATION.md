# Configuração e manutenção

## Arquivo `.env`

O instalador cria `.env` na raiz do projeto e preserva valores válidos durante reinstalações.

```dotenv
CBM_CACHE_DIR=/caminho/do/clone/cache
CBM_ALLOWED_ROOT=/caminho/do/clone/repositories
CBM_MEM_BUDGET_MB=8192
CBM_HOST_BIN=/home/usuario/.local/bin/codebase-memory-mcp
LOCAL_UID=1000
LOCAL_GID=1000
UI_PORT=8080
OPENWEBUI_PUBLIC_URL=https://<host-openwebui>
OPENWEBUI_PUBLIC_HOST=<host-openwebui>
ADMIN_PUBLIC_URL=https://<host-admin>
ADMIN_PUBLIC_HOST=<host-admin>
GRAFANA_PUBLIC_URL=https://<host-grafana>
GRAFANA_PUBLIC_HOST=<host-grafana>
MCP_PUBLIC_URL=https://<host-mcp>
MCP_PUBLIC_HOST=<host-mcp>
WORKSPACE_TIMEZONE=America/Maceio
REPOSITORY_SYNC_CONCURRENCY=3
OLLAMA_VERSION=0.32.1
OLLAMA_CHAT_MODEL=gemma4:e2b
OLLAMA_KV_CACHE_QUANTIZATION=fp16
OLLAMA_KEEP_ALIVE=-1
OLLAMA_RUNTIME=docker
OLLAMA_BASE_URL=http://ollama:11434
COMPOSE_FILE=/caminho/do/clone/compose.yaml:/caminho/do/clone/compose.gpu.yaml
COMPOSE_PROFILES=ollama-docker,monitoring
OLLAMA_GPU_MODE=all
OLLAMA_GPU_DEVICE_IDS=
DOCLING_VERSION=v1.26.0
DOCLING_CPU_THREADS=6
RAG_RERANKING_MODEL=BAAI/bge-reranker-v2-m3
RAG_RERANKING_BATCH_SIZE=4
RAG_TOP_K=20
RAG_TOP_K_RERANKER=8
```

| Variável | Finalidade |
| --- | --- |
| `CBM_MEM_BUDGET_MB` | Orçamento de memória do Codebase Memory. |
| `UI_PORT` | Porta HTTP do proxy, vinculada somente a `127.0.0.1` para consumo pelo túnel no host. |
| `OPENWEBUI_PUBLIC_URL` | Origem pública do Open WebUI, sem barra final nem caminho. |
| `OPENWEBUI_PUBLIC_HOST` | Hostname extraído da origem do Open WebUI e usado pelo Nginx. |
| `ADMIN_PUBLIC_URL` | Origem pública do painel administrativo. |
| `ADMIN_PUBLIC_HOST` | Hostname do painel administrativo usado pelo Nginx. |
| `GRAFANA_PUBLIC_URL` | Origem pública do Grafana. |
| `GRAFANA_PUBLIC_HOST` | Hostname do Grafana usado pelo Nginx. |
| `MCP_PUBLIC_URL` | Origem pública do endpoint MCP; o endpoint fica na raiz. |
| `MCP_PUBLIC_HOST` | Hostname do MCP usado pelo Nginx. |
| `WORKSPACE_TIMEZONE` | Fuso padrão dos agendamentos de repositórios e Drive. |
| `REPOSITORY_SYNC_CONCURRENCY` | Sincronizações Git simultâneas, entre 1 e 20. |
| `OLLAMA_CHAT_MODEL` | Modelo de chat baixado pelo instalador. |
| `OLLAMA_KV_CACHE_QUANTIZATION` | Quantização do cache K/V: `fp16` (padrão) ou `q8_0`. |
| `OLLAMA_KEEP_ALIVE` | Residência dos modelos: `-1` (indefinida), `30m` ou `5m` (padrão do Ollama). |
| `OLLAMA_RUNTIME` | `docker` ou `host` no macOS. |
| `COMPOSE_FILE` | Manifests base e overrides gerados que todo comando Compose deve carregar. |
| `OLLAMA_GPU_MODE` | `cpu`, `all`, `selected` ou `metal`. |
| `OLLAMA_GPU_DEVICE_IDS` | UUIDs NVIDIA separados por vírgula. |
| `DOCLING_VERSION` | Tag estável da imagem `docling-serve-cpu`. |
| `DOCLING_CPU_THREADS` | Threads de CPU destinadas ao Docling. |
| `RAG_RERANKING_MODEL` | Cross-encoder multilíngue usado pelo Open WebUI. Vazio desativa o modelo. |
| `RAG_RERANKING_BATCH_SIZE` | Batch do reranker; valores menores reduzem picos de RAM. |
| `RAG_TOP_K` | Candidatos recuperados pela busca híbrida. |
| `RAG_TOP_K_RERANKER` | Resultados mantidos depois do reranking. |

Execute novamente `./install.sh` após alterações que exijam recriação dos serviços.

O instalador gera `compose.ollama.yaml` com `OLLAMA_KEEP_ALIVE` e, ao selecionar residência indefinida, limita a dois modelos simultâneos com `OLLAMA_MAX_LOADED_MODELS=2`. Ao selecionar `q8_0`, o mesmo override recebe `OLLAMA_FLASH_ATTENTION=1` e `OLLAMA_KV_CACHE_TYPE=q8_0`. No modo host do macOS, os valores equivalentes são adicionados ao LaunchAgent.

## GPU NVIDIA

No Linux, o instalador detecta GPUs com `nvidia-smi`, instala/configura o NVIDIA Container Toolkit quando necessário e gera `compose.gpu.yaml`. A GPU é reservada ao Ollama; o Docling permanece explicitamente em CPU.

Quando o Docker usa `systemd` com cgroup v2, o instalador adiciona `native.cgroupdriver=cgroupfs` ao `/etc/docker/daemon.json`, preservando as opções existentes e criando um backup. Essa é a mitigação recomendada pela NVIDIA para impedir que containers percam acesso à GPU após reloads do systemd. Como a configuração é global ao Docker, o daemon é reiniciado durante a instalação.

O override de GPU também substitui o healthcheck do Ollama: além de listar os modelos, ele exige que `nvidia-smi` responda dentro do container. Assim, uma perda de acesso à GPU deixa o serviço explicitamente `unhealthy`, em vez de permitir fallback silencioso para CPU.

O `.env` mantém `COMPOSE_FILE` com `compose.yaml` e todos os overrides gerados. Assim, comandos comuns como `docker compose up -d`, inclusive os executados por automações de inicialização após um reboot, continuam aplicando a reserva NVIDIA e a quantização escolhida sem exigir uma nova instalação.

Seleções usam UUID, não índice. Isso evita que mudanças na ordem das placas alterem a GPU escolhida.

Para validar:

```bash
docker compose exec -T ollama nvidia-smi
docker compose exec -T ollama ollama ps
```

## Reranking

O reranker local é carregado pelo Open WebUI em CPU. Na primeira inicialização ele pode baixar o modelo e demorar mais para ficar saudável.

Para desativar sem editar o compose:

```dotenv
RAG_RERANKING_MODEL=
```

Depois recrie o Open WebUI. Compare qualidade, RAM e latência antes de aumentar `RAG_TOP_K`, `RAG_TOP_K_RERANKER` ou o batch.

## Operação dos serviços

```bash
docker compose ps
docker compose logs --tail=200 docling open-webui knowledge-sync
docker compose restart docling
```

Prometheus e Grafana fazem parte do profile `monitoring`, habilitado pelo instalador em `COMPOSE_PROFILES`. Prometheus não possui porta no host; o Grafana é acessado exclusivamente pela origem definida em `GRAFANA_PUBLIC_URL` e usa sua própria tela de login. O dashboard operacional também é incorporado na área **Observabilidade** do painel; o proxy autoriza como `frame-ancestor` somente a origem administrativa configurada. A credencial inicial fica armazenada com permissão `0600` em `data/secrets/monitoring.env`.

O instalador solicita quatro origens públicas distintas. Cada serviço opera na raiz de seu próprio hostname, sem `/admin`, `/grafana` ou `/mcp`:

```text
https://<host-openwebui>/ Open WebUI
https://<host-admin>/     painel administrativo
https://<host-grafana>/   Grafana
https://<host-mcp>/       endpoint MCP
```

Depois de alterar qualquer URL ou hostname público, recrie `admin`, `open-webui`, `grafana` e `proxy` ou execute novamente o instalador. As variáveis `*_PUBLIC_HOST` devem corresponder exatamente ao hostname de suas respectivas URLs.

Para Cloudflare Tunnel executado no host, crie quatro aplicações publicadas, todas com serviço de origem `http://127.0.0.1:8080`. Mantenha a opção **HTTP Host Header** sem sobrescrita, pois o Nginx usa o hostname público recebido para selecionar o serviço. O DNS associa cada hostname ao túnel; a porta pertence à configuração da origem, não ao registro DNS. O proxy aceita HTTP local porque o TLS público termina na Cloudflare e o transporte até o host já ocorre dentro do túnel criptografado. Não configure a origem como `https://127.0.0.1:8080`.

O túnel ou proxy externo deve encaminhar `X-Forwarded-Proto: https`; assim, o painel marca automaticamente o cookie administrativo como `Secure`.

O painel administrativo usa o usuário definido pelo instalador, JWT assinado e cookie `HttpOnly`, `SameSite=Strict`, limitado à raiz do hostname administrativo. Não há cadastro nem recuperação de senha. A alteração da credencial é feita executando novamente `./install.sh`. Os arquivos `data/secrets/admin.env` e `data/secrets/admin-jwt-secret` devem permanecer com permissão `0600`.

A página **Operações** mantém em `data/jobs.json` os logs dos últimos sete dias e apresenta dez operações por página. O arquivo é preservado durante reinstalações; operações que estavam em execução quando o serviço reiniciou são registradas como interrompidas.

O Grafana abre por padrão o dashboard provisionado **Codebase Memory — Operação**. Ele é atualizado a partir do arquivo versionado `monitoring/grafana/dashboards/codebase-memory-operation.json`; crie outro dashboard para customizações locais, pois o provisionado é somente leitura.

O healthcheck do Docling consulta `/health`. O Open WebUI só inicia depois que o Docling estiver saudável.

## Atualizações

- Fixe versões de Docling, Ollama e Open WebUI; para imagens públicas que só oferecem tags flutuantes, fixe também o digest OCI.
- Leia notas de release antes de alterar uma imagem.
- Faça backup do estado persistente.
- Recrie e valide os serviços.
- Reprocesse uma base de teste com PDF nativo, escaneado, tabelas e imagens.
- Trocar o modelo de embedding exige recriar os embeddings das Knowledge Bases.

## Estrutura do projeto

```text
codebase-memory-mcp-server/
├── app/                    # painel e BFF administrativo
├── agentgateway/           # gateway MCP
├── knowledge-sync/         # sincronização Drive → Knowledge Base
├── nginx/                  # proxy
├── openwebui/              # imagem derivada e bootstrap
├── skills/                 # skill distribuída com o projeto
├── cache/                  # índices locais
├── data/                   # estado e segredos
├── repositories/           # clones por workspace
├── compose.yaml
├── compose.ollama.yaml     # gerado quando q8_0 é selecionado
├── compose.gpu.yaml        # gerado quando necessário
├── install.sh
└── .env
```

Mantenha o clone no mesmo caminho depois da instalação, pois `.env` contém caminhos absolutos.
