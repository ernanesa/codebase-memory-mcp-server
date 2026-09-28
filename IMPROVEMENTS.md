# Melhorias incorporadas do Codex

Fonte de referência: `/home/ernane/Personal/Codex`, main `49d9da8`.
Baseline do servidor após a mesclagem: `7a6f1f7`.

| Capacidade | Implementação neste projeto | Limite verificável |
| --- | --- | --- |
| Avaliação de recuperação | `code-eval/` e `CODE-RETRIEVAL-EVALUATION.md` | Fixtures provam as métricas; melhoria de relevância precisa corpus real e endpoint. |
| Fusão RRF e diversidade | `app/src/retrieval-policy.js` | Diversidade opt-in na facade; fusão precisa múltiplas fontes reais autorizadas. |
| Orçamento fast/balanced/thorough | Política determinística da facade | Não ativa embeddings ou reranker ausentes no backend. |
| Proveniência do índice | `app/src/index-evidence.js`, metadata `_meta` no MCP | Commit e working tree precisam permanecer iguais/limpos antes e depois; a observação expira em 5 minutos e estado legado permanece desconhecido. |
| Grafo Roslyn/TypeScript | `scripts/import-semantic-graph.mjs` | Importa JSON existente. Ingestão no motor externo precisa contrato próprio. |
| Identidade de chunks | Hash/ID estável no módulo de fusão | Evita colapsar trechos com o mesmo título. |
| Reranker com fallback | Validação de scores no módulo de política | Sem chamada automática a outro modelo. |
| Entrega verificável | Workflows e lock SHA-256 em `.codex/` | Revisão e validação continuam obrigatórias. |

O motor Codebase Memory é montado por `CBM_HOST_BIN`; este repositório não
contém seu código nem controla sua versão real. Mudanças no armazenamento,
indexação semântica e busca vetorial requerem validar o motor efetivamente
instalado. Não há migração automática de SQLite/Qdrant.

O cliente de IA local do Codex fixa um modelo e endpoint diferentes do stack
deste servidor. O roteador experimental não executa operações e não substitui
autorização. Esses serviços, templates de trading e configuração Antigravity
não foram importados por não serem capacidades do servidor atual.

## Correções operacionais

- Cache local pós-backend identificado por argumentos, escopo, evidência e hash
  da resposta, com TTL e teto de bytes. Ele reduz pós-processamento, não evita
  a busca no motor nem significa tokens de entrada reutilizados pelo modelo.
- Colisões de nomes entre projetos são bloqueadas para tokens restritos porque
  o motor externo recebe apenas o nome, sem identidade de repositório.
- Testes permanecem indexados; busca e trace os ocultam por padrão e aceitam
  `include_tests: true` quando são necessários. Busca sem resultados estruturados
  falha fechada, porque texto livre não permite filtrar testes com segurança.
- Lista de ferramentas ordenada por nome e limites de tamanho/quantidade evitam
  variação e respostas MCP desnecessariamente grandes.
- Busca não infere classe/função exclusivamente pela capitalização.
- Alias ambíguo exige projeto explícito; acesso é reavaliado na resposta.
- JSON textual é preservado para clientes sem structuredContent.
- Criação de repositório verifica o workspace antes dos efeitos.
- Métricas agregam labels equivalentes e escapam quebras de linha.
- Cache de resposta publica contadores hit/miss/eviction por camada, sem
  cardinalidade por projeto ou consulta.

## Validação e promoção

Use Node 26, a versão declarada pelos serviços. Execute as suítes do app,
knowledge-sync, rag-eval e code-eval, verifique o lock e `git diff --check`.
Mantenha dataset e commit indexado fixos em comparações. Meça Recall/nDCG/MRR,
frescor, latência p95 e bytes frios/quentes. Não classifique a implementação
como superior ao baseline até executar a comparação contra o backend real.

O importador de grafo e a fusão são extensões verificadas localmente, não
evidência de indexação semântica em produção. Deploy não faz parte desta mudança.
