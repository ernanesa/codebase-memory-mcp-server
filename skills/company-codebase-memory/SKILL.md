---
name: company-codebase-memory
description: Investigar repositórios da empresa pelo MCP Codebase Memory para compreender arquitetura, fluxos de negócio, símbolos, chamadas, dependências, impacto de mudanças, cobertura do índice e código desconhecido. Usar ao responder perguntas sobre implementação, localizar responsabilidades, seguir fluxos entre funções, analisar bugs ou planejar alterações nos repositórios indexados; combinar o grafo com a leitura do código local antes de concluir.
---

# Company Codebase Memory

Usar o Codebase Memory como mapa de navegação do código. Tratar o repositório e seus testes como fonte final de verdade.

## Preparar a investigação

1. Localizar o servidor MCP que exponha `list_projects` e as ferramentas de análise do Codebase Memory. O identificador configurado pelo cliente pode variar.
2. Se o servidor não estiver conectado, explicar objetivamente a falha de configuração e continuar com ferramentas locais quando o código estiver disponível.
3. Nunca solicitar, imprimir, registrar ou persistir a API key. A credencial deve chegar ao cliente por variável de ambiente ou armazenamento seguro.
4. Não usar a credencial Sistema/Playground. Trabalhar somente com o token individual do desenvolvedor.

## Selecionar o projeto correto

1. Chamar `list_projects` no início da investigação.
2. Considerar a resposta como a lista de projetos visíveis para a credencial atual. Tokens individuais recebem somente projetos autorizados; a credencial Sistema/Playground pode receber todos.
3. Relacionar o repositório atual ao resultado por caminho raiz, nome, remoto Git ou outros metadados retornados.
4. Usar exatamente o identificador técnico retornado no campo `name` ou `project`, conforme o schema da resposta. Não derivar o ID do nome `owner/repository` e não inventar slug.
5. Se houver mais de um candidato plausível, apresentar os candidatos e pedir a escolha antes de fazer uma análise extensa.
6. Se o repositório esperado não aparecer, não afirmar apenas com essa ausência que ele inexiste ou que o usuário não tem acesso. A lista é filtrada e a ausência também pode significar que o projeto ainda não foi indexado. Informar essa ambiguidade e orientar a confirmação no painel administrativo.

Reutilizar o projeto selecionado nas chamadas seguintes. Não alternar de projeto silenciosamente.

## Executar a investigação

Adaptar a sequência ao pedido e aos schemas publicados em `tools/list`:

1. Obter visão geral com `get_architecture` quando a pergunta envolver módulos, camadas, componentes ou responsabilidades amplas.
2. Usar `search_graph` para encontrar conceitos, símbolos e relações; usar `query_graph` quando for necessária uma consulta estrutural precisa.
3. Usar `trace_path` para seguir chamadores, chamadas e caminhos internos. Com token individual, não selecionar o modo `cross_service`, pois ele pode atravessar repositórios e exige credencial de sistema.
4. Usar `search_code` para localizar texto, símbolos ou implementações e `get_code_snippet` para recuperar o trecho relevante.
5. Usar `get_graph_schema` antes de montar consultas quando os tipos de nós, relações ou argumentos não estiverem claros.
6. Consultar `index_status` e `detect_changes` quando a resposta depender de completude, atualidade ou ausência de resultados.
7. Abrir os arquivos relevantes no repositório local e confirmar assinaturas, condições, tratamento de erros, configuração e testes.
8. Expandir a busca somente quando a evidência atual não sustentar a conclusão.

Ler [references/tools-and-recipes.md](references/tools-and-recipes.md) para escolher ferramentas e sequências por tipo de pergunta.

## Formar evidência

Separar claramente:

- fato observado no grafo;
- fato confirmado no código ou em testes;
- inferência baseada em ambos;
- lacuna causada por índice incompleto ou desatualizado.

Antes de afirmar que algo "não existe", "não é usado" ou "não possui chamadores":

1. verificar a cobertura e o estado do índice;
2. pesquisar por mais de uma estratégia quando houver variações de nome;
3. confirmar com busca local no repositório;
4. qualificar a conclusão se a cobertura não for suficiente.

Ao responder, citar arquivos, símbolos e linhas quando disponíveis. Para fluxos, descrever a sequência de entrada até o efeito final e indicar os pontos em que a evidência muda de arquivo, módulo ou serviço.

## Respeitar autorização

Tokens individuais permitem somente ferramentas de análise e repositórios explicitamente liberados no painel:

- `list_projects` é filtrado para os projetos permitidos;
- `tools/list` é filtrado para esconder ferramentas não autorizadas;
- chamadas que recebem `project` são validadas contra o ID técnico;
- `trace_path` com `cross_service` é restrito;
- indexação, exclusão, ADRs e ingestão de traces exigem a credencial de sistema.

Não tentar contornar a ACL, trocar de credencial ou inferir conteúdo de repositórios não visíveis. Se a tarefa exigir uma operação administrativa, explicar a necessidade e direcionar o usuário ao administrador.

Ler [references/security-and-troubleshooting.md](references/security-and-troubleshooting.md) ao encontrar falhas de autenticação, autorização, projeto ausente, índice incompleto, timeout ou indisponibilidade.

## Usar fallback local

Usar `rg` (ripgrep) e `fd` como ferramentas de alta performance em Rust, leitura de arquivos, testes e histórico Git como complemento ou fallback quando:

- o MCP estiver indisponível;
- o repositório não estiver indexado;
- o índice estiver incompleto ou desatualizado;
- for necessário confirmar detalhes exatos da implementação;
- a ferramenta necessária não estiver liberada para o token individual.

Evitar comandos lentos legados como `grep -rn` ou `find .` em árvores inteiras de código quando `rg` e `fd` estiverem disponíveis no ambiente.

Não apresentar o fallback como resultado do Codebase Memory. Informar qual fonte sustentou cada conclusão importante.

## Entregar a resposta

Começar pela conclusão útil ao desenvolvedor. Depois incluir apenas a evidência necessária:

1. projeto MCP consultado;
2. fluxo, arquitetura ou impacto encontrado;
3. arquivos e símbolos que sustentam a conclusão;
4. incertezas de cobertura ou atualidade;
5. próximos passos concretos quando houver lacunas.

Não despejar respostas brutas das ferramentas nem alegar cobertura total sem verificá-la.
