# Operação e dimensionamento da IA corporativa

Esta política cobre apenas fontes corporativas autorizadas. Repositórios de trading,
cryptotrading, diretórios pessoais e dados de sessão não entram no servidor, nos
índices, em caches nem nos snapshots. Os testes abaixo usam prompts sintéticos.

## Estado e limites de partida

- O perfil inicial do instalador usa contexto de 16.384 tokens, um modelo Ollama
  carregado, uma requisição paralela e fila máxima de 16. Esses números são
  limites conservadores, não capacidade comprovada do host. Instalações com
  `OLLAMA_CONTEXT_LENGTH` já definido mantêm o valor anterior.
- Ollama fica publicado apenas em `127.0.0.1:11434` no host. Open WebUI e outros
  containers usam a rede interna do Compose. Exposição externa exige controle
  de rede, autenticação e decisão operacional explícita.
- O override Docker aceita `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_NUM_PARALLEL` e
  `OLLAMA_MAX_QUEUE` pelo ambiente do Compose. Contexto maior, mais modelos e
  paralelismo consomem VRAM adicional; não aumentá-los juntos em produção.
- O Docling usa CPU. A fila de sincronização documental tem concorrência global
  de um. Uma mudança de modelo de embeddings exige reindexação das Knowledge
  Bases correspondentes.

## Preflight e benchmark

Executar a partir da raiz do checkout, sem imprimir `.env` ou configuração
expandida do Compose:

```sh
node scripts/ai-capacity-preflight.mjs
node scripts/ai-capacity-preflight.mjs --live
```

O primeiro comando valida o Compose e resume a GPU. `--live` consulta apenas
`127.0.0.1:11434/api/ps`, relata a quantidade de modelos e a VRAM declarada,
sem nomes. `not_verified` significa que uma medição não estava disponível; não
equivale a zero nem a falha de capacidade.

O benchmark local envia somente um prompt fixo sintético e nunca imprime texto
de entrada, resposta ou identificador do modelo. Execute em janela controlada
para evitar disputa com usuários:

```sh
node scripts/benchmark-ollama-runtime.mjs --model MODELO_INSTALADO --context 8192 --concurrency 1 --repeats 10
```

Repita com contextos de 4K, 8K, 16K e 32K e concorrência 1, 2 e 4 quando houver
folga de VRAM. Registre commit, versão Ollama, quantização, GPU, modelos
residentes, primeira carga, p50/p95, tokens por segundo, erros e fila. O
benchmark é um teste de capacidade de geração curta; não mede qualidade de
código, relevância do RAG, sessão Codex nem custo por tarefa correta. Para o
fluxo MCP, use `scripts/benchmark-mcp-runtime.mjs` com casos corporativos sem
segredos e com autorização própria.

Promova configurações somente após medir tarefas representativas de código e
RAG: correção/testes/revisão, p95, tempo até primeiro token, custo por tarefa
aceita, taxa de repetição, VRAM, RAM e falhas sob carga. Não extrapole capacidade
do benchmark sintético para desenvolvedores simultâneos.

## Métricas e alertas

O Prometheus carrega `monitoring/ai-alerts.yml`; o Grafana provisiona o painel
`Codebase Memory — Eficiência de IA`. ACL e cache MCP usam contadores locais do
admin. Tokens, custo e latência de IA dependem da chamada efetiva a
`recordAiUsage` pelo roteador/provedor. Painel vazio significa ausência de
instrumentação ou tráfego, não custo zero.

Os limiares de ACL (>50 rejeições/5 min), latência p95 (>30 s com pelo menos 20
amostras/10 min) e custo (>US$ 10/h) são pilotos; ajuste-os com baseline e
orçamento aprovado. As regras ficam visíveis em Prometheus. Não há Alertmanager
ou canal de notificação configurado por este pacote; alertas externos exigem
integração separada e teste de entrega. Nenhuma métrica inclui prompt,
resposta, usuário, token, caminho ou conteúdo de repositório nos labels.

O hit de cache MCP e os tokens de entrada em cache do provedor são métricas
diferentes. Não inferir economia de tokens OpenAI a partir do cache MCP. Para
custos, conciliar contadores locais com o consumo faturado do provedor.

## Verificação de backup e restauração

Produza um snapshot consistente e criptografado em armazenamento corporativo
autorizado. Inclua estado `data/`, índices `cache/`, volume `openwebui-data`,
volume `ollama-data` e `repositories/` se os clones precisarem ser preservados.
Mantenha a chave de criptografia do workspace em cofre separado, com procedimento
de recuperação testado. Proteja a cópia externa e a retenção por política
corporativa.

Restaure o snapshot em uma área isolada, sem publicar serviços. Organize duas
árvores imutáveis, uma da captura original e outra da restauração, com os
diretórios de topo esperados. Compare conteúdo por SHA-256 sem exibir nomes ou
bytes:

```sh
node scripts/verify-staged-restore.mjs --snapshot-root /caminho/seguro/snapshot --restored-root /caminho/seguro/restore
```

O script só lê arquivos e rejeita symlinks. Uma comparação igual comprova
integridade de bytes dos diretórios selecionados; ainda é necessário validar,
no ambiente isolado, inicialização, autorização, busca, citações e recuperação
dos tokens cifrados. Se os clones também forem necessários, passe
`--sections data,cache,repositories,openwebui-data,ollama-data`.
