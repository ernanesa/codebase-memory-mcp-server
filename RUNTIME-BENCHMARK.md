# Benchmark de runtime do MCP

`scripts/benchmark-mcp-runtime.mjs` mede uma chamada MCP completa por operação: negociação de sessão, `initialized` e `tools/call`. Ele não grava relatórios, não imprime token, endpoint, consultas, argumentos ou conteúdo de respostas. A saída JSON contém somente métricas agregadas e um fingerprint do destino.

## Pré-requisitos

Crie um arquivo de casos fora do repositório. Casos devem ser estáveis entre execuções e não podem conter segredos. O formato é:

```json
[
  {
    "id": "search-symbol",
    "tool": "code_search_surgical",
    "arguments": {
      "project": "projeto-controlado",
      "query": "consulta-estavel"
    }
  }
]
```

Defina o endpoint e o token apenas no ambiente. Não acrescente valores de token à linha de comando, ao arquivo de casos ou a relatórios. `--engine` (ou `CBM_BENCHMARK_ENGINE`) identifica a revisão/build/engine sob teste; o valor não deve conter informação privada.

```sh
export CBM_BENCHMARK_MCP_ENDPOINT='https://mcp.example.internal/mcp'
export CBM_BENCHMARK_MCP_TOKEN='token-fornecido-por-cofre'
node scripts/benchmark-mcp-runtime.mjs --cases /caminho-seguro/casos.json --phase warm --warmup 2 --repeats 20 --concurrency 4 --engine node26-build-a
```

O cliente exige endpoint HTTP(S), token não vazio e casos JSON válidos. Ele não faz chamadas se essas condições não forem atendidas. Não há endpoint padrão e nenhuma chamada externa é feita sem as duas variáveis de ambiente.

## Comparação Node 22 e Node 26

Execute a mesma revisão do MCP, imagem/base de sistema, hardware, endpoint, autorização, corpus, commit indexado, configuração do backend e arquivo de casos. Capture a saída em local seguro fora do repositório.

Faça duas séries separadas:

1. `cold`: `--phase cold --warmup 0`, uma execução curta imediatamente após iniciar ou reiniciar o processo do servidor. O runner não reinicia o servidor. Registre o reinício externo junto ao relatório: sem ele, a fase significa apenas que não houve warmup do cliente. Cada relatório inclui PID do cliente, fingerprint dos casos e ambiente, mas isso não prova cold start do servidor.
2. `warm`: `--phase warm --warmup 2`, seguido de repetições suficientes para estabilizar as métricas. O warmup não entra nas métricas principais.

Repita cada série diversas vezes e compare p50, p95, p99, throughput, contagem de erros e bytes de resposta. Preserve a primeira saída como baseline e passe-a via `--compare /caminho/baseline.json` nas execuções seguintes. O relatório só calcula deltas quando schema, fingerprint dos casos, fase, concorrência e repetições coincidem; engine e destino aparecem para revisão humana. Deltas negativos são melhoria para latência/erros/bytes, positivos para throughput. Não existe threshold universal neste harness: configure e aprove SLO por serviço antes de promover. O benchmark mede o caminho MCP completo; não atribua uma diferença diretamente ao Node sem acompanhar CPU, RSS, heap, atraso do event loop e latência do backend. Também não use um hit do cache local como evidência de cache de tokens do modelo.

`--concurrency` controla quantas operações completas são disparadas em paralelo. Comece em 1 e aumente gradualmente. Cada operação cria uma sessão MCP própria, portanto este benchmark mede o custo de clientes curtos e independentes; ele não representa uma sessão persistente do Codex.

## Limites

O relatório não contém consultas ou respostas e não avalia relevância. Use [CODE-RETRIEVAL-EVALUATION.md](CODE-RETRIEVAL-EVALUATION.md) para a avaliação de qualidade. Uma comparação real não foi executada por esta mudança: ela requer endpoint e token autorizados, casos representativos sem segredos, engine/build identificado, corpus e revisão indexada fixos, e SLO/threshold aprovado. O fingerprint de destino é hash truncado da URL para permitir verificar se duas execuções apontam ao mesmo alvo sem revelar a URL.
