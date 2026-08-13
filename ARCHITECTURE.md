# Arquitetura e operação técnica

Este documento descreve os serviços, fluxos de dados, persistência e decisões operacionais do ambiente.

## Visão dos serviços

```text
Navegador ──► Cloudflare Tunnel ──► Nginx por hostname ──┬──► Open WebUI
                                                        ├──► painel administrativo
                                                        └──► Grafana

Clientes MCP ──► Cloudflare Tunnel ──► hostname MCP ──► AgentGateway ──► Codebase Memory MCP
                                      │
                                      └── controle de tokens e projetos permitidos

Google Drive ──┐
               ├─► knowledge-sync ──► Open WebUI
Links HTTPS ───┘
                                         │
                              ┌──────────┴──────────┐
                              ▼                     ▼
                        Docling CPU           Ollama GPU/host
                    extração e OCR       chat e embeddings bge-m3
                              │                     │
                              └──────────┬──────────┘
                                         ▼
                            Knowledge Bases e RAG híbrido
```

| Serviço | Responsabilidade |
| --- | --- |
| `proxy` | Único ponto de entrada; publica Open WebUI, painel, Grafana e MCP. |
| `agentgateway` | Encaminha chamadas MCP e aplica as credenciais configuradas. |
| `admin` | Gerencia workspaces, repositórios, usuários MCP e integração do Drive. |
| `open-webui` | Mantém chats, Knowledge Bases, arquivos, chunks e índice vetorial. |
| `docling` | Converte documentos, executa OCR adaptativo e extrai tabelas. |
| `ollama` | Executa o modelo de chat e o embedding `bge-m3`. |
| `knowledge-sync` | Detecta mudanças no Drive, coleta links HTTPS e envia apenas conteúdos alterados. |

## Pipeline de documentos

1. Um arquivo é enviado manualmente ou detectado pelo `knowledge-sync`.
2. O Open WebUI encaminha o arquivo ao Docling.
3. O Docling preserva a estrutura textual, extrai tabelas e usa OCR quando necessário.
4. O Open WebUI divide o Markdown por página e em chunks.
5. O Ollama gera embeddings com `bge-m3`.
6. A consulta combina busca vetorial e lexical.
7. O reranker `BAAI/bge-reranker-v2-m3` ordena até 20 candidatos e mantém até 8 resultados.
8. Os melhores trechos, metadados e citações são enviados ao modelo de chat.

### Citações canônicas do Google Drive

Para arquivos sincronizados, o `knowledge-sync` solicita o `webViewLink` fornecido pela API do Drive e o envia ao Open WebUI junto com o nome original. O arquivo exportado (`.txt`, `.csv` ou `.pdf`) continua sendo a representação interna usada por Docling e pelos embeddings, mas os chunks registram o documento do Drive como fonte canônica.

Links públicos HTTPS podem ser vinculados à mesma Knowledge Base, com descrição opcional. Em cada execução do cron, o worker faz uma requisição condicional com `ETag` e `Last-Modified`, extrai HTML estático, JSON, XML, Markdown ou texto, acrescenta a descrição ao documento e reindexa somente quando o conteúdo semântico muda. Cada cadastro representa uma única URL: não há crawling, autenticação nem execução de JavaScript.

O coletor bloqueia credenciais na URL, localhost, redes privadas ou reservadas e revalida DNS e cada redirecionamento. Os limites padrão são 30 segundos, cinco redirecionamentos e 10 MiB. Falhas preservam a última versão indexada e tornam a execução parcial.

Ao clicar no marcador ou na lista de fontes, o frontend exibe o nome original como rótulo e abre o arquivo original em uma nova aba, sem expor o URL como texto nem exibir o modal técnico de chunks e scores. O link não contém credenciais da Service Account: o Google valida a conta ativa no navegador e as permissões próprias do usuário. Uploads manuais e fontes sem URL canônica mantêm o endpoint interno do Open WebUI como fallback.

Somente URLs HTTPS retornadas nos hosts `docs.google.com` e `drive.google.com` são aceitas como fontes do Drive. Documentos de links usam a URL HTTPS validada pelo coletor. A versão do metadata da citação é persistida por arquivo; depois desta funcionalidade ser instalada, uma reconciliação completa reenvia automaticamente uma única vez os arquivos antigos que ainda não possuem a versão atual.

A abertura no trecho exato não é garantida. O pipeline preserva páginas quando o extrator as fornece, mas Google Docs, Sheets e Slides exigem identificadores estruturais que as exportações atuais em texto ou CSV não mantêm.

### Leitura pelo filesystem virtual da Knowledge Base

O comando `tree -a` do `kb_exec` apresenta cada arquivo no formato explícito `path="..." file_id="..."`, evitando que o modelo interprete o ID como um diretório do caminho. Tanto o valor completo de `path` quanto o `file_id`, usados separadamente, são referências válidas para comandos como `cat`, `grep`, `head` e `sed`.

Como tolerância a caminhos reconstruídos pelo modelo, o resolvedor normaliza caracteres Unicode, aceita um caminho sem os diretórios ancestrais e remove um `file_id` inserido acidentalmente como segmento. Essas correções só são aplicadas quando o resultado identifica exatamente um arquivo acessível. Se houver dois resultados possíveis, a leitura é recusada e os IDs e caminhos completos são retornados. Essa tolerância não amplia acesso: a busca permanece limitada às Knowledge Bases autorizadas para o usuário.

Quando `kb_exec` executa um comando que lê conteúdo, o middleware resolve novamente somente as referências explícitas do comando e publica os arquivos encontrados como fontes da resposta. Comandos meramente exploratórios, como `tree`, `ls` e `find`, não geram citações. Assim, uma resposta baseada em `cat`, `head`, `tail`, `sed`, `grep`, `wc` ou `stat` mantém origem mesmo sem uma chamada adicional a `query_knowledge_files`.

### OCR adaptativo

A configuração usa:

```json
{
  "do_ocr": true,
  "force_ocr": false,
  "ocr_engine": "tesseract",
  "ocr_lang": ["por", "eng"],
  "table_mode": "accurate"
}
```

O Docling aproveita texto nativo quando disponível e aplica OCR em páginas ou regiões que precisam dele. PDFs com uma camada textual defeituosa podem exigir reprocessamento manual com `force_ocr=true`.

### Imagens dentro dos documentos

O carregador Docling do Open WebUI usa `image_export_mode=placeholder` e indexa somente o Markdown devolvido. Portanto:

- texto visível em páginas escaneadas pode ser recuperado pelo OCR;
- tabelas são representadas como texto estruturado;
- a imagem binária não é incorporada pelo `bge-m3`;
- figuras não são retornadas automaticamente como thumbnails no chat.

Descrição semântica e retorno visual de figuras são evoluções separadas. Elas exigem um modelo visual, armazenamento das imagens, metadados de página/figura e suporte de renderização no chat. Não se deve inserir base64 nos chunks.

## Por que o Docling usa CPU

O ambiente de produção prioriza o Ollama em uma GPU NVIDIA dedicada. O Docling permanece em CPU para que OCR, layout e TableFormer não disputem VRAM com:

- modelo de chat e cache KV;
- embeddings `bge-m3`;
- possíveis modelos visuais futuros.

A imagem é `docling-serve-cpu`, fixada em uma versão explícita. O serviço usa um worker, compartilha modelos e mantém apenas um conversor no cache. `DOCLING_NUM_THREADS` controla o paralelismo de CPU.

Se um benchmark real mostrar que os lotes não terminam antes da próxima janela, pode-se criar um perfil CUDA separado. A decisão deve considerar também a latência do chat durante a ingestão.

## Docling stateless

O Docling não possui volume nem bind mount. Os modelos são parte da imagem e os resultados são devolvidos ao Open WebUI na mesma requisição. Ao recriar o container, somente arquivos temporários são perdidos.

Não monte um volume vazio sobre `/opt/app-root/src/.cache/docling/models`: ele ocultaria os modelos incorporados à imagem. Um volume de modelos só será necessário se uma futura imagem slim fizer download de artefatos em runtime.

## Agendamento e fila do Google Drive

Cada vínculo entre pastas e Knowledge Base possui:

- expressão cron de cinco campos;
- fuso IANA, como `America/Maceio`;
- estado ativo ou pausado;
- histórico e próxima execução.

O padrão é:

```cron
30 * * * *
```

O worker verifica agendas a cada 30 segundos, mas usa os slots do cron. Se estiver indisponível no instante exato, executa o último slot pendente ao voltar. Um slot persistido não é executado duas vezes.

Depois da primeira varredura completa, o worker persiste um token da Google Drive Changes API. Execuções seguintes consultam mudanças primeiro e encerram sem percorrer a árvore quando nenhuma alteração afeta pastas ou arquivos conhecidos. Alterações relevantes disparam uma reconciliação completa. Uma reconciliação de segurança também ocorre periodicamente, por padrão a cada 168 horas.

Falhas de download ou ingestão são isoladas por arquivo. O manifesto registra estado, erro, tentativa, sucesso e duração, permitindo repetir somente o documento afetado pelo painel. Erros 429 e 5xx do Drive e do Open WebUI usam retry com backoff exponencial.

Todas as Knowledge Bases compartilham uma fila com concorrência global `1`. Vínculos vencidos são processados sequencialmente para limitar CPU, RAM e pressão sobre o Open WebUI. A ação **Sincronizar agora** entra na mesma fila.

Estados antigos com `intervalMinutes` são migrados automaticamente. O intervalo legado de 60 minutos vira `30 * * * *`.

## Persistência e backup

| Dado | Local |
| --- | --- |
| Estado administrativo e segredos | `data/` |
| Histórico de operações do painel (7 dias) | `data/jobs.json` |
| Estado e manifesto do Drive | `data/knowledge-sync/state.json` |
| Clones dos repositórios | `repositories/` |
| Índices do Codebase Memory | `cache/` |
| Chats, arquivos, chunks e vetores | volume `openwebui-data` |
| Modelos Ollama em Docker | volume `ollama-data` |
| Modelos Ollama no macOS host | `~/.ollama` |
| Modelos Docling | imagem Docker, sem volume |

O backup mínimo deve incluir `data/`, `cache/`, `repositories/` quando os clones precisarem ser preservados, e os volumes do Open WebUI e Ollama. A chave `data/secrets/mcp-workspace-encryption-key` é indispensável para revelar tokens restaurados.

## Segurança operacional

- Não exponha Ollama, Docling ou `knowledge-sync` diretamente à rede pública.
- Mantenha a porta do proxy vinculada somente a `127.0.0.1`.
- Publique somente os quatro hostnames do proxy pelo túnel ou por infraestrutura HTTPS equivalente.
- Use tokens MCP individuais quando o acesso não puder abranger todo o workspace.
- Restrinja a Service Account do Drive a leitura das pastas necessárias.
- Mantenha `data/`, `.env` e credenciais fora do Git.
- Monitore RAM, VRAM, tempo dos lotes e latência do chat antes de aumentar workers ou batches.

## Observabilidade

O `admin` expõe liveness em `/api/health/live`, readiness agregado em `/api/health/ready`, detalhes em `/api/health/detail` e métricas Prometheus em `/api/metrics`. O worker expõe `/health/live`, `/health/ready` e `/metrics` na rede interna.

O instalador habilita o profile Compose `monitoring`, que inicia Prometheus e Grafana junto com os demais serviços. Em instalações manuais, use:

```bash
docker compose --profile monitoring up -d prometheus grafana
```

Prometheus permanece exclusivamente na rede Docker e não possui rota no proxy. O Grafana é publicado na raiz de seu hostname, utiliza seu login próprio e tem o dashboard operacional incorporado na área **Observabilidade** do painel administrativo. O proxy restringe o embedding com `frame-ancestors` à origem administrativa configurada. Em produção, a infraestrutura externa deve terminar HTTPS e restringir a origem conforme as políticas da organização.

As métricas não usam perguntas, nomes de arquivo ou usuário como labels. Logs operacionais são JSON e utilizam IDs de operação, sem conteúdo documental ou credenciais.

O Grafana provisiona automaticamente o datasource Prometheus e o dashboard versionado **Codebase Memory — Operação**. O dashboard provisionado não é editável; dashboards adicionais criados pelo usuário são preservados no volume `grafana-data`.

## Referências oficiais

- [Docling Serve: imagens de container](https://github.com/docling-project/docling-serve#container-images)
- [Docling Serve: configuração](https://github.com/docling-project/docling-serve/blob/main/docs/configuration.md)
- [Docling Serve: implantação](https://github.com/docling-project/docling-serve/blob/main/docs/deployment.md)
- [Open WebUI](https://docs.openwebui.com/)
