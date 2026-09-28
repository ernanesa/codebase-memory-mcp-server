# Artefato de grafo semântico

`scripts/import-semantic-graph.mjs` converte JSON já produzido pelo analisador Roslyn do projeto Codex ou por `typescript-graph.mjs` em um artefato local, normalizado e determinístico. Ele não executa MSBuild, Roslyn ou TypeScript e não envia dados ao backend MCP.

```bash
node scripts/import-semantic-graph.mjs \
  --input ./analysis/roslyn.json --workspace /repos/pedidos --project pedidos \
  --source-hash <sha256-do-input> --commit <git-sha> \
  --output ./analysis/semantic-graph.json
```

O importador aceita somente arquivo regular dentro do workspace escolhido, rejeita links simbólicos no arquivo, na raiz e nos diretórios ancestrais, caminhos fora da raiz, `.env` e diretórios tipicamente sensíveis. A entrada é limitada a 10 MiB e a 10.000 relações por padrão. Cada aresta e chunk recebe ID SHA-256 estável baseado no projeto, caminho, proveniência e conteúdo semântico. Relações inválidas, duplicadas, referências a caminhos sensíveis e texto que parece conter segredo são descartadas.

O formato Roslyn atual produz relações sem caminho quando a entrada é uma solução ou projeto. Esse formato agregado é recusado, pois atribuir suas relações a `.sln` ou `.csproj` corromperia a proveniência. A entrada Roslyn de um único `.cs` é aceita; análises agregadas passam a ser aceitas quando o analisador emitir `file`, `filePath` ou `sourceRef` em cada relação.

O artefato inclui `project`, `parser`, `sourceHash` e `commit` para permitir verificação de frescor. A integração com a ingestão/grafo do backend requer um contrato próprio e não é feita por este script.
