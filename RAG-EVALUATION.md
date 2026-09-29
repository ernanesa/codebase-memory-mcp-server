# Avaliação de RAG

`rag-eval/` oferece avaliação determinística de respostas, citações, limites de acesso, abstenção, custo e latência. O workflow executa somente fixtures sintéticas; não acessa Open WebUI, não precisa de chave e não usa conteúdo corporativo.

## Contrato do dataset

Veja `rag-eval/datasets/example.json` para um dataset integralmente sintético. Cada caso pode declarar:

| Campo | Uso |
| --- | --- |
| `id`, `question` | Identificador único e pergunta de teste |
| `tags` | Agrupa casos, por exemplo `acl`, `revocation`, `prompt-injection`, `citations` |
| `requiredFacts` | Fatos que a resposta deve conter; lista aninhada permite alternativas |
| `forbiddenFacts`, `mustNotReveal` | Conteúdo que nunca deve aparecer na resposta; use canários fictícios |
| `expectedDocuments` | IDs de fonte que devem aparecer nas citações |
| `forbiddenDocuments` | IDs de fonte proibidos nas citações |
| `expectAbstention` | Exige resposta explícita sem evidência ou sem acesso |
| `access.allowedSourceIds` | Allowlist de citações; lista vazia significa que nenhuma fonte pode ser citada |
| `access.deniedSourceIds` | Fontes que não podem aparecer nas citações |
| `access.revokedSourceIds` | Fontes cuja permissão foi revogada e não podem aparecer nas citações |
| `maxLatencyMs`, `maxCostUsd` | Limite por caso; ausência de telemetria reprova quando um limite está configurado |

IDs permitidos, negados e revogados não podem se sobrepor. O avaliador falha em citações desconhecidas quando há allowlist e em citações sem identificador. As fontes são reconhecidas por IDs, nomes, caminhos ou URIs em estruturas comuns de citação. Custo e tokens ausentes no serviço são reportados como `null`; não são presumidos como zero.

Os checks de ACL verificam apenas o que a resposta expôs em citações e texto. Fixtures não provam que um backend real aplicou autorização antes da recuperação ou antes de enviar contexto ao modelo. Para validar isso, prepare uma avaliação controlada no ambiente de teste com identidade e políticas reais; não use datasets corporativos no CI público.

## CI sintético

No diretório do projeto:

```bash
cd rag-eval
npm test
RAG_EVAL_RESPONSES_FILE=fixtures/baseline-responses.json \
  npm run evaluate -- datasets/example.json reports/baseline.json
RAG_EVAL_RESPONSES_FILE=fixtures/responses.json \
  npm run evaluate -- datasets/example.json reports/candidate.json
npm run compare -- reports/baseline.json reports/candidate.json regression-policy.json
```

`.github/workflows/rag-evaluation.yml` executa essa sequência em alterações relevantes. Ele usa somente respostas, IDs, perguntas e canários inventados; não injeta segredos ou dados privados no job. Os relatórios ficam em `rag-eval/reports/`, excluídos do Git.

## Avaliar o serviço em ambiente controlado

Cadastre perguntas e fatos sintéticos ou aprovados para teste em um arquivo fora do Git. Nunca salve credenciais, respostas confidenciais, texto de documentos ou estado de sessão no dataset versionado. Configure a autenticação pelo ambiente do processo:

```bash
cd rag-eval
OPENWEBUI_URL=http://localhost:3000 \
OPENWEBUI_API_KEY="$RAG_EVAL_API_KEY" \
RAG_EVAL_MODEL='modelo-de-teste' \
npm run evaluate -- /caminho/seguro/dataset.json reports/candidate.json
```

Alternativamente, defina `WEBUI_ADMIN_EMAIL` e `WEBUI_ADMIN_PASSWORD` no gerenciador de segredos do ambiente. Não escreva esses valores no dataset, workflow ou linha de comando persistida no histórico do shell. Se a API não fornecer contagem de tokens, custo ou citações, as respectivas métricas não ficam comprovadas; os limites correspondentes devem reprovar ou ser reportados como indisponíveis, não presumidos como zero.

`RAG_EVAL_MIN_PASS_RATE` sobrescreve o mínimo configurado no dataset. `RAG_EVAL_TIMEOUT_MS` ajusta o timeout da chamada. `RAG_EVAL_RESPONSES_FILE` executa fixtures sem autenticação e é destinado a testes offline.

## Comparar baseline e candidato

Gere dois relatórios a partir do mesmo dataset e compare:

```bash
npm run compare -- reports/baseline.json reports/candidate.json regression-policy.json
```

A comparação reprova se um caso que passava deixar de passar, um caso da baseline desaparecer, a queda de pass rate exceder o limite ou p95, custo e tokens ultrapassarem o crescimento permitido. Quando um limite para uma métrica está configurado, a comparação falha se a baseline ou o candidato não tiver essa métrica. `regression-policy.json` aceita `maxPassRateDrop`, `maxP95LatencyGrowth`, `maxCostGrowth`, `maxInputTokenGrowth` e `maxOutputTokenGrowth`, em frações (por exemplo `0.2` = 20%).

Registre a baseline por versão do modelo, prompt, política, corpus/indexação e configuração de retrieval. Compare a mesma amostra de perguntas; caso contrário, variação do conjunto pode mascarar regressões. Para latência e custo operacionais, repita consultas suficientes e compare percentis/total, porque os fixtures do CI têm valores estáticos e não são benchmark de produção.

## Critérios de promoção

Avalie separadamente recuperação (Recall@k, MRR ou nDCG com relevância rotulada), cobertura e precisão de citações, fidelidade da resposta, abstenção, vazamento entre ACLs, revogação de acesso, resistência a prompt injection e custos/latência. Mude chunking, embeddings, top-k, fusão híbrida ou reranking somente com comparação contra a mesma baseline e regressões de segurança bloqueantes.

Resultados automáticos são sinais de avaliação, não prova absoluta de correção. Revise amostras e falhas com pessoas autorizadas. A avaliação, os fixtures e caches não devem conter nem indexar repositórios pessoais ou conteúdo fora do escopo corporativo.
