# Operação SOTA de RAG e MCP

## Ingestão e ACL por chunk

O clone e a sincronização periódica da `main` permanecem o mecanismo de
ingestão. Não há GitHub App nem allowlist obrigatória de IDs de repositório.

Repositórios existentes antes desta política não são autoaprovados. Antes do
primeiro deploy, um responsável deve conferir cada origem e preparar um JSON
privado com `approvedBy` e uma entrada `{workspaceId, repositoryId,
githubRepositoryId}` para **cada** repositório legado. Execute primeiro a
simulação e só depois a aplicação, sobre um snapshot recuperável de
`data/state.json`:

```bash
node scripts/migrate-legacy-source-approvals.mjs \
  --state-file data/state.json --approval-file /caminho/privado/aprovacoes.json
node scripts/migrate-legacy-source-approvals.mjs \
  --state-file data/state.json --approval-file /caminho/privado/aprovacoes.json --apply
```

O utilitário exige cobertura exata, IDs numéricos estáveis, um responsável
identificado e arquivos regulares; sua saída contém apenas contagens. Não use
o modo `--apply` sem uma aprovação humana verificável das fontes.

O indexador deve gravar em cada chunk `project` e, para controle explícito,
`aclProjects` (lista de projetos que podem consumir o chunk). Durante a
transição, chunks sem `aclProjects` são aceitos apenas se pertencem ao projeto
solicitado e já autorizado no MCP. Um chunk com `project` diferente ou ACL
explícita incompatível é removido antes de serializar e antes de entrar no
cache.

## Cache

O cache semântico é somente para leituras determinísticas, limitado por TTL e
tamanho. Sua chave inclui escopo de projetos, evidência de índice e versão da
política de ACL. Ele é limpo após reindexação e depois de qualquer alteração
de acesso de usuário MCP. Não armazene prompts, credenciais, conteúdo de
chat, resultados de escrita nem respostas sem evidência de projeto.

## Roteamento de modelos

`/api/ai-policy/route` fornece decisão determinística e **consultiva**. O
processo que efetivamente chama um modelo deve mapear as rotas estáveis para
modelos configurados no ambiente: `local_fast`, `hosted_general`,
`hosted_reasoning` e `hosted_long_context`. Risco alto, confiança de RAG menor
que 0,55 e contexto muito grande sobem de rota. A escolha não contém prompt ou
identidade, e deve ser registrada só em forma agregada.

## Métricas e gate

`/api/metrics` expõe contadores agregados de ACL, tokens, cache, custo e
latência. `rag-eval` aceita `forbiddenDocuments`, `maxLatencyMs`,
`maxCostUsd` e preços por milhão de tokens. Uma troca de embedding, reranker,
modelo ou política só deve ser promovida quando o dataset corporativo passar o
limiar configurado e não apresentar citação proibida, regressão de latência ou
custo.
