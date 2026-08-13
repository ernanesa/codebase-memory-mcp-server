# Configurar o Google Drive para sincronização

Este guia prepara um projeto no Google Cloud para dois recursos configurados pelo painel administrativo: o Picker manual nativo do Open WebUI e a sincronização automática de pastas com Knowledge Bases. A instalação não solicita credenciais.

O Picker usa OAuth Client ID e API Key. A sincronização usa o JSON de uma Service Account. Você pode configurar somente um dos recursos ou ambos.

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Pré-requisitos</summary>

- Uma conta Google com permissão para criar ou administrar um projeto no [Google Cloud Console](https://console.cloud.google.com/).
- Acesso ao painel administrativo da instalação.
- Permissão para compartilhar no Google Drive as pastas que serão sincronizadas.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Criar o projeto e habilitar a API</summary>

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/).
2. Use o seletor no topo para criar ou escolher um projeto.
3. Abra **APIs e serviços → Biblioteca**.
4. Procure por **Google Drive API**, abra o resultado e clique em **Ativar**.
5. Para usar o Picker manual, ative também **Google Picker API**.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Criar a Service Account</summary>

1. No projeto, abra **IAM e administrador → Contas de serviço**.
2. Clique em **Criar conta de serviço**.
3. Informe um nome, por exemplo `openwebui-knowledge-sync`.
4. Não conceda papéis de IAM no projeto; o acesso aos documentos será dado diretamente no Drive.
5. Abra a conta criada e acesse **Chaves → Adicionar chave → Criar nova chave**.
6. Selecione **JSON** e guarde o arquivo baixado em um local protegido.

O worker enxerga somente arquivos e pastas acessíveis à Service Account. Não publique o JSON, não o envie para o Git e não conceda permissão de edição.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Executar o instalador</summary>

Execute normalmente:

```bash
./install.sh
```

O instalador não faz perguntas sobre Google Drive. Ele gera somente o token interno entre o painel e o worker, constrói o serviço `knowledge-sync` e o inicia junto aos demais containers.

Sem credencial, o worker responde ao painel, mas não consulta o Google nem executa agendamentos. Não é necessário reinstalar ou reiniciar containers depois de configurar o Picker ou enviar o JSON.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Enviar a Service Account pelo painel</summary>

1. Em qualquer computador com acesso ao servidor, abra `http://<servidor>:8080/admin/`.
2. Entre em **Bases e fontes**.
3. Clique em **Configurar Google Drive**.
4. Use **Arquivo da Service Account** para selecionar o JSON baixado do Google Cloud. Como alternativa avançada, abra **Ou cole o conteúdo do JSON**.
5. Confira o e-mail e o projeto mostrados na prévia e clique em **Salvar credencial**.
6. Clique em **Testar conexão**.
7. Copie o e-mail da Service Account exibido no painel.
8. No Google Drive, compartilhe cada pasta desejada com esse e-mail como **Leitor**.

O upload parte do navegador usado para acessar o painel; o servidor não precisa ter interface gráfica. O painel salva o arquivo em `data/secrets/knowledge-sync/google-drive-service-account.json`, com permissão `0600`. Somente esse subdiretório é montado, para leitura, no worker; os demais segredos do sistema ficam fora do alcance dele. A chave privada nunca é devolvida pela API nem exibida novamente.

A opção **Remover** apaga o arquivo do servidor e pausa os vínculos existentes, preservando os arquivos já enviados às bases.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Vincular pastas às Knowledge Bases</summary>

1. Crie as Knowledge Bases desejadas no Open WebUI.
2. Associe cada modelo somente à sua respectiva base.
3. Em **Bases e fontes**, localize a Knowledge Base e clique em **Vincular fontes**.
4. Selecione uma ou mais pastas acessíveis à Service Account.
5. Preencha os cinco campos do cron e o fuso horário. O padrão `30 * * * *` executa no minuto 30 de cada hora.
6. Use **Sincronizar agora** para antecipar a primeira execução e acompanhe o histórico.

Use **Pausar** para interromper novas verificações sem remover conteúdo. A ação **Desvincular** remove da Knowledge Base os arquivos enviados pelo worker e preserva os originais no Drive.

Cada vínculo é isolado pelo ID da Knowledge Base. Arquivos da Pasta A enviados para a Base A não entram na Base B. Dentro da base, o worker cria a estrutura `Google Drive (gerenciado)/<pasta>--<id>/` e registra somente os arquivos que ele próprio enviou. Exclusões no Drive removem apenas esses arquivos gerenciados; uploads manuais são preservados.

As citações desses arquivos abrem diretamente o documento original usando o `webViewLink` retornado pelo Drive. O acesso é avaliado pelo Google com a conta ativa no navegador: compartilhar a pasta apenas com a Service Account permite a sincronização, mas não concede acesso aos usuários finais. Compartilhe os documentos também com os usuários, grupos ou domínio que devem abrir as fontes. Arquivos configurados como “qualquer pessoa com o link” seguem essa política mais ampla do próprio Drive.

Depois de atualizar uma instalação que ainda possua citações internas, a primeira sincronização ignora o atalho incremental e reprocessa uma vez os arquivos gerenciados para gravar a URL canônica. O conteúdo original no Drive não é alterado.

Quando mais de uma base vence no mesmo horário, o worker processa os vínculos sequencialmente. Isso evita que várias extrações Docling e indexações concorram por CPU e memória. A ação **Sincronizar agora** usa a mesma fila.

O scheduler tolera reinícios: se o worker estiver indisponível no minuto exato, executará o último slot pendente quando voltar. O estado persistido impede a repetição do mesmo slot. Instalações antigas com intervalo de 60 minutos são migradas automaticamente para `30 * * * *`.

O fluxo é unidirecional: alterações feitas no Drive chegam ao Open WebUI. Alterar ou remover arquivos diretamente na área gerenciada da base não modifica o Drive e pode ser revertido na próxima sincronização.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Validar a sincronização</summary>

1. No painel, use **Testar conexão**.
2. Vincule uma pasta pequena a uma Knowledge Base de teste.
3. Clique em **Sincronizar agora** e abra **Histórico**.
4. Acesse a Knowledge Base no Open WebUI e confirme que os arquivos aparecem na área gerenciada.
5. Edite um arquivo no Drive, sincronize novamente e confirme a atualização.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Configurar o Picker nativo pelo painel</summary>

O Picker permite que usuários importem arquivos manualmente pelo menu de anexos. Ele é independente da sincronização e exige OAuth Client ID e API Key.

1. Ative **Google Picker API** no mesmo projeto.
2. Configure a tela de consentimento em **Google Auth Platform** e adicione os escopos `drive.readonly` e `drive.file`.
3. Crie um OAuth Client do tipo **Web application** e cadastre a origem usada para acessar o Open WebUI.
4. Crie uma API Key restrita ao site e às APIs Google Drive e Google Picker.
5. Abra `http://<servidor>:8080/admin/` e entre em **Bases e fontes**.
6. No card **Integração do Open WebUI**, clique em **Configurar Picker**.
7. Informe o OAuth Client ID e a API Key e clique em **Salvar e ativar**.
8. Recarregue abas do Open WebUI que já estavam abertas.

O painel persiste as credenciais no banco do Open WebUI e ativa `google_drive.enable` na mesma operação. A API Key não é devolvida pelo painel depois de salva. **Desativar** remove as duas credenciais e desliga a integração.

Não informe nem armazene o OAuth Client Secret; o Picker não o utiliza.

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Solução de problemas</summary>

| Sintoma | Verificação |
| --- | --- |
| JSON recusado | Confirme que foi baixado como chave JSON de uma Service Account e contém `type`, `client_email` e `private_key`. |
| Teste de conexão falha | Confirme que a Google Drive API está ativa no projeto e substitua uma chave revogada. |
| A pasta não aparece | Compartilhe-a como Leitor com o e-mail exibido no painel. Também é possível informar diretamente o folder ID. |
| Worker indisponível | Consulte `docker compose ps knowledge-sync` e `docker compose logs knowledge-sync`. Ele é iniciado automaticamente pela instalação. |
| Sincronização falha ao autenticar no Open WebUI | Execute novamente o instalador para recriar o worker com a credencial administrativa atual. |
| Origem vazia | O worker preserva os arquivos existentes quando uma origem previamente preenchida retorna vazia. Verifique permissões e disponibilidade do Drive. |
| Cron recusado | Use cinco campos (`minuto hora dia mês dia-da-semana`) e valores dentro dos intervalos exibidos no painel. |
| Execução aguardando | Outro vínculo pode estar em processamento. Todas as bases compartilham uma fila sequencial. |
| Picker manual não aparece | Confirme no painel que o card mostra **Ativado no Open WebUI** e recarregue a aba do Open WebUI. |

</details>

---

<details>
<summary style="font-size: 1.5em; font-weight: bold;">Referências oficiais</summary>

- [Google Drive API](https://developers.google.com/workspace/drive/api/guides/about-sdk)
- [Criar e gerenciar Service Accounts](https://cloud.google.com/iam/docs/service-accounts-create)
- [Criar e excluir chaves de Service Account](https://cloud.google.com/iam/docs/keys-create-delete)
- [Compartilhar arquivos e pastas no Google Drive](https://support.google.com/drive/answer/2494822)
- [Integração Google Drive no Open WebUI](https://docs.openwebui.com/features/chat-conversations/rag/#google-drive-integration)
- [Configurar o Google Picker para uma aplicação web](https://developers.google.com/workspace/drive/picker/guides/web-picker)

</details>
