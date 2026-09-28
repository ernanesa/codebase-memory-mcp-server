# Uso do MCP com Codex e cache de contexto

Este servidor não controla nem força o cache interno de tokens do Codex. A política de cache do modelo é gerenciada pelo produto. O servidor pode reduzir e estabilizar o conteúdo que chega ao cliente MCP, o que favorece prefixos repetidos e reduz tokens enviados por resposta.

## Recomendações

- Mantenha a lista e os schemas das ferramentas estáveis durante uma tarefa. O servidor ordena `tools/list` por nome para não depender da ordem retornada pelo motor externo.
- Abra uma conversa nova para cada tarefa independente. Continue na conversa atual enquanto investigação, implementação e correções fizerem parte do mesmo objetivo; não mantenha um histórico longo apenas para tentar preservar cache.
- Antes de começar, envie um handoff curto com objetivo, critério de conclusão, restrições, estado Git, arquivos/símbolos relevantes, decisões/evidências e próximo passo. Para uma tarefa nova, transfira esse resumo, não a conversa completa.
- Faça recuperação progressiva. Comece com `code_search_surgical` e uma consulta curta; peça snippets, traces ou testes só quando a evidência inicial indicar essa necessidade. Use um orçamento inicial de quatro chamadas MCP para mapear a tarefa e amplie apenas quando houver uma lacuna de evidência identificada.
- A busca e os traces omitem referências de teste por padrão. Use `include_tests: true` quando a pergunta depender de fixtures, regressões ou contrato de testes. Os arquivos continuam disponíveis no índice do motor, cuja regra de ingestão deve ser confirmada separadamente.
- Prefira `limit` pequeno e aumente apenas quando a primeira resposta não trouxer evidência suficiente. O facade limita buscas a 50 resultados.
- Preserve os metadados de proveniência (`project`, revisão indexada e estado `fresh`, `stale` ou `unknown`) ao resumir evidências. Não trate `unknown` como confirmação de atualidade.
- Mantenha instruções gerais e definições de ferramentas curtas e estáveis; acrescente os detalhes variáveis da tarefa depois delas. Evite reordenar ferramentas, repetir arquivos extensos ou enviar `bin`, `obj`, `node_modules`, logs e testes completos sem necessidade.
- Ao encerrar uma etapa, retenha apenas objetivo, decisões ainda válidas, evidências localizadas, arquivos afetados, checks executados/pendentes, riscos e próxima ação. Descarte saídas brutas já resumidas e hipóteses invalidadas.

### Handoff mínimo

Copie e preencha este bloco ao iniciar uma conversa nova ou delegar uma fatia independente:

```text
Objetivo:
Critério de conclusão:
Restrições:
Repo/commit e estado Git:
Arquivos/símbolos relevantes:
Evidências e decisões válidas:
Checks pendentes:
Próxima ação:
```

Envie a cada agente apenas sua fatia, seus caminhos permitidos, critérios, invariantes e evidências relevantes. Um agente por caminho mutável; invalide handoffs dependentes quando a base Git ou uma premissa compartilhada mudar.

## Cache de prompt: limites e prática

O cache de prompt pode reutilizar prefixos idênticos; ele não torna útil um histórico irrelevante nem reduz o conteúdo exclusivo da tarefa. Preserve o prefixo estável de instruções e ferramentas e coloque consultas, resultados de recuperação e logs depois dele. Uma conversa nova reduz acúmulo e ruído, mas pode não reutilizar o cache da conversa anterior. Uma conversa contínua também não garante cache hit. Não altere o fluxo para manter uma conversa gigante só por uma expectativa de cache.

As regras e métricas de cache variam por modelo e superfície. A documentação da API não comprova que a interface Codex exponha os mesmos controles ou métricas. Também não presuma cache compartilhado entre Sol e Luna: confirme somente com telemetria da superfície usada. Não use chamadas artificiais de “keepalive/cache bump” nem ferramentas de compressão sem comparação medida.

## Avaliação do fluxo

Compare o fluxo atual com “conversa nova + handoff mínimo + recuperação progressiva” em 20–30 tarefas representativas, mantendo comparáveis modelo, configuração, tarefa e revisão do repositório. Quando disponíveis, registre tokens de entrada/saída e tokens em cache, latência, chamadas MCP, bytes de resposta, correções/retrabalho e conclusão correta. Compare medianas e custo/tempo por tarefa correta; marque métricas não expostas como `not verified` em vez de estimá-las.

Não armazene prompts, conteúdo de arquivos, tokens, credenciais ou dados de sessão nas métricas. Não habilite logging bruto de conversas para medir economia.

## O que as métricas significam

`mcp_guardrail_cache_events_total` mede o cache local do servidor. Ele só responde depois que o backend executou a ferramenta e compara o hash da resposta original; um hit economiza parte do pós-processamento/serialização, não a busca no engine nem tokens de entrada do modelo. O cache é particionado por escopo e evidência, tem TTL e limites de entradas/bytes.

Esse contador não mede cache de prompt do Codex. Compare tokens em cache, latência e custo do modelo somente com telemetria disponibilizada pelo cliente ou pela API utilizada. Não coloque prompts, conteúdo de arquivos, tokens ou dados de sessão em métricas e relatórios.

## Limites de indexação

O servidor chama o executável externo definido por `CBM_HOST_BIN`/`CBM_BIN` e envia o caminho do repositório. Ele não define, neste checkout, os excludes do indexador. A política local de ocultar testes na resposta MCP é seletiva e não prova que o motor exclua `bin`, `obj`, `node_modules` ou outras pastas. Valide os excludes no binário e na revisão de índice implantados antes de atribuir redução de contexto ao índice.

O estado de cache compartilhado entre Sol e Luna deve ser acompanhado como comportamento do Codex. Este repositório não fixa modelo nem contém um controle para forçar hits entre modelos.

## Guarda de escopo por tarefa

Antes de editar, registre o estado do worktree e os arquivos permitidos no envelope:

```sh
node scripts/task-scope-guard.mjs snapshot --task-id <id> --envelope <envelope.json>
```

Ao concluir, verifique os novos caminhos sujos:

```sh
node scripts/task-scope-guard.mjs verify --task-id <id> --envelope <envelope.json>
```

O envelope deve conter `taskId` igual ao argumento e declarar cada caminho permitido em `files[].path`. Ele deve estar dentro do worktree, sem componentes de symlink, e seus caminhos não podem conter componentes `.` ou `..`. A guarda grava apenas uma lista de caminhos já sujos, HEAD e branch no diretório Git privado; ela não lê nem calcula hash do conteúdo do worktree. A verificação falha se HEAD ou branch mudarem desde o snapshot. Ela detecta somente caminhos que passaram a aparecer no status após o snapshot. Não detecta novas edições em um caminho que já estava sujo no snapshot, portanto esse caminho só deve constar no envelope quando a tarefa realmente o possui.
