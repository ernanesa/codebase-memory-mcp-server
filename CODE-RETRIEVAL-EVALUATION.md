# Avaliação de retrieval de código

`code-eval` mede a qualidade das evidências retornadas pelo MCP. Ele não avalia texto gerado por modelo nem executa indexação. Os rótulos ficam separados das fontes indexadas.

## Métricas

- `recallAtK`: proporção de caminhos e símbolos rotulados recuperados até K;
- `ndcgAtK`: prioridade dos acertos no ranking, sem contar a mesma evidência duas vezes;
- `mrr`: posição do primeiro acerto;
- `evidencePathRecall`: cobertura dos caminhos exigidos;
- `citationFreshness`: hashes retornados que ainda coincidem com o arquivo local;
- `p50LatencyMs`, `p95LatencyMs`, `meanResponseBytes` e `p95ResponseBytes`.

Cada caso representa uma pergunta de símbolo ou um chunk isolado. Use caminhos relativos ao `--source-root`; não coloque tokens, conteúdo confidencial ou respostas completas no dataset. Caminhos `.env`, `secret(s)` e `credential(s)` são recusados. O frescor resolve o caminho real antes de ler o arquivo, então um symlink que saia do root também é recusado. O relatório omite o conteúdo retornado e registra somente caminho, símbolo, hash e estado de frescor.

## Execução com fixtures

Requer Node.js 26, sem dependências externas:

```bash
cd code-eval
npm test
npm run evaluate:fixtures
```

## Execução contra MCP HTTP

Crie um arquivo de consultas versionável, sem segredos:

```json
[
  {
    "id": "find-order-handler",
    "query": "CreateOrder",
    "project": "plataforma-api",
    "expectedSymbols": ["CreateOrder"],
    "relevantPaths": ["src/Orders/OrderService.cs"],
    "requiredEvidencePaths": ["src/Orders/OrderService.cs"]
  }
]
```

Forneça o token somente por variável de ambiente e escreva o relatório com permissões de dono:

```bash
export CODE_EVAL_MCP_TOKEN='token-fornecido-pelo-segredo-local'
node code-eval/runner.mjs \
  --endpoint https://mcp.example.com/ \
  --queries code-eval/queries.local.json \
  --source-root /caminho/para/repositorio \
  --output /tmp/code-eval-report.json
```

O runner executa o ciclo `initialize` → `notifications/initialized` → `tools/call`, reutiliza a sessão quando o servidor a fornece e envia a versão de protocolo negociada nas requisições posteriores. Ele aceita resposta JSON ou SSE, incluindo eventos, comentários, CRLF e múltiplas linhas `data:`. Por padrão chama `code_search_surgical`; cada caso pode selecionar `get_symbol_snippet` ou `search_graph`, e acrescentar argumentos seguros em `toolArguments`. Erros de sessão, autenticação, schema, `isError` ou resposta interrompem a execução para evitar publicar uma comparação inválida.

O runner registra fingerprint SHA-256 do dataset normalizado, identidade local do runtime (Node/V8/plataforma), quantidade de casos e, se fornecido, um identificador derivado do `HEAD` em `--source-root`. `--repeats N` repete cada caso N vezes; o relatório traz amostras individuais e resumo por caso, além do agregado. Fixture offline continua apropriada para validar o evaluator, mas seu tempo de execução não representa latência MCP real.

```bash
node code-eval/runner.mjs --endpoint "$CBM_EVAL_ENDPOINT" --queries /caminho/casos.json --source-root /caminho/revisao-local --repeats 5 --output /tmp/eval.json
```

Estabeleça primeiro uma baseline real por fase/estado do índice e preserve os relatórios fora do repositório. Compare somente com o mesmo fingerprint de dataset, engine, revisão/corpus indexado, limites da busca, configuração do backend e fase. Cada relatório mantém sua identidade; mudança de runtime ou dataset deve aparecer como comparação nova, sem misturar métricas. Um gate local inicial sugerido é não aceitar regressão em `recallAtK`, `evidencePathRecall` ou frescor; p95 deve respeitar o SLO acordado pelo serviço. Os valores do SLO e as consultas rotuladas são entradas externas do time, não são inventados pelo harness.

Uma alteração só deve ser promovida após as métricas de recuperação, isolamento por projeto, frescor e p95 atenderem aos thresholds aprovados. A fixture verifica lógica e segurança do avaliador, não qualidade real do índice.
