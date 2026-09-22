# Ferramentas e receitas de investigação

Os schemas publicados pelo servidor em `tools/list` são a autoridade para nomes de argumentos, valores aceitos e formatos de resposta. Não inventar parâmetros com base apenas neste documento.

## Catálogo de análise

| Ferramenta | Uso principal | Observações |
| --- | --- | --- |
| `inspect_symbol` | Inspeção cirúrgica completa em 1 passo | Retorna código limpo, assinatura e callers/callees de produção. Poupa múltiplos turnos. |
| `code_search_surgical` | Busca cirúrgica FTS5/BM25 com ranking | Retorna tabela Markdown compacta sem ruído JSON (economia de 85% de tokens). |
| `trace_symbol` | Seguir chamadores e chamadas de produção | Suprime automaticamente arquivos de teste e mocks. |
| `get_symbol_snippet` | Recuperar o código do símbolo higienizado | Remove campos vazios de AST e cabeçalhos de licença repetidos. |
| `list_projects` | Descobrir os projetos visíveis e seus IDs técnicos | Chamar antes das ferramentas que exigem `project`; a resposta é filtrada para tokens individuais. |
| `get_architecture` | Obter uma visão geral de componentes e responsabilidades | Usar como ponto de partida em perguntas amplas, não como substituto da leitura do código. |
| `get_graph_schema` | Conhecer tipos de nós, relações e capacidades do grafo | Consultar antes de escrever uma `query_graph` que dependa do schema. |
| `search_graph` | Encontrar símbolos, conceitos e relações relevantes | Começar com termos específicos e expandir gradualmente. |
| `query_graph` | Executar investigação estrutural precisa | Preferir quando a pergunta exige filtros ou relações que a busca geral não expressa bem. |
| `trace_path` | Seguir caminhos de chamadas e dependências | Respeitar os modos descritos no schema; `cross_service` exige credencial de sistema. |
| `search_code` | Pesquisar texto ou símbolos no conteúdo indexado | Confirmar no arquivo local quando detalhes exatos importarem. |
| `get_code_snippet` | Recuperar o contexto de uma ocorrência | Pedir somente o contexto necessário para reduzir ruído. |
| `index_status` | Verificar estado e atualidade da indexação | Usar diante de resultados ausentes ou suspeita de atualização pendente. |
| `detect_changes` | Identificar diferenças entre o índice e o repositório | Usar quando o código pode ter mudado depois da indexação. |

## Receita: compreender um fluxo de negócio

1. Executar `list_projects` e selecionar o ID técnico.
2. Buscar o conceito, endpoint, evento ou caso de uso com `search_graph`.
3. Identificar o ponto de entrada e seguir chamadas com `trace_path`.
4. Recuperar implementações decisivas com `get_code_snippet` ou `search_code`.
5. Abrir localmente handlers, serviços, repositórios, integrações e testes.
6. Descrever o caminho entrada → validação → regra → persistência/integração → resposta/evento.
7. Marcar ramificações, efeitos colaterais e inferências.

## Receita: analisar impacto de alteração

1. Localizar o símbolo ou contrato alterado.
2. Consultar suas relações no grafo e seguir chamadores/called paths.
3. Investigar implementações, interfaces, serialização, configuração e testes relacionados.
4. Verificar cobertura e atualidade do índice.
5. Confirmar referências com busca local.
6. Classificar impactos como confirmados, prováveis ou não avaliados.

## Receita: localizar responsabilidade

1. Obter arquitetura quando o domínio for desconhecido.
2. Buscar substantivos e verbos do comportamento solicitado.
3. Relacionar resultados a módulos, classes, funções e endpoints.
4. Abrir o código dos candidatos e eliminar falsos positivos.
5. Informar o ponto de entrada, o núcleo da regra e os adaptadores externos separadamente.

## Receita: investigar bug

1. Traduzir o sintoma em ponto de entrada, estado esperado e efeito observado.
2. Encontrar o ponto de entrada e seguir o caminho executável.
3. Conferir validações, condições, tratamento de erro, concorrência e integrações.
4. Procurar testes que cubram o comportamento e lacunas relevantes.
5. Diferenciar causa comprovada de hipótese e indicar como validar a hipótese.

## Receita: responder uma conclusão negativa

Para perguntas como "quem chama?", "isso ainda é usado?" ou "existe implementação?":

1. pesquisar nomes exatos e variantes;
2. consultar relações no grafo;
3. verificar `index_status` e, quando aplicável, `detect_changes`;
4. executar busca local;
5. usar linguagem limitada ao escopo realmente verificado.

Exemplo adequado: "Não encontrei chamadores no projeto X nem na busca local; a cobertura informada foi Y. Isso não avalia repositórios que sua credencial não consegue listar."
