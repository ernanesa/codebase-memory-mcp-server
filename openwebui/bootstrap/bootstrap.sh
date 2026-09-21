#!/bin/sh

set -eu

: "${OPENWEBUI_URL:?OPENWEBUI_URL não configurada}"
: "${OLLAMA_URL:?OLLAMA_URL não configurada}"
: "${WEBUI_ADMIN_EMAIL:?WEBUI_ADMIN_EMAIL não configurado}"
: "${WEBUI_ADMIN_PASSWORD:?WEBUI_ADMIN_PASSWORD não configurado}"
: "${OLLAMA_CHAT_MODEL:=qwen2.5-coder:14b-instruct-q4_0}"
: "${OLLAMA_BUSINESS_MODEL:=ornith15-9b-ad:latest}"
: "${OLLAMA_CONTEXT_LENGTH:=64000}"
: "${OLLAMA_EMBEDDING_MODEL:=bge-m3}"
: "${RAG_RERANKING_MODEL:=}"
: "${RAG_RERANKING_BATCH_SIZE:=4}"
: "${RAG_TOP_K:=20}"
: "${RAG_TOP_K_RERANKER:=8}"
: "${MCP_ADMIN_URL:?MCP_ADMIN_URL não configurada}"
: "${MCP_SYSTEM_TOKEN_FILE:?MCP_SYSTEM_TOKEN_FILE não configurado}"

[ -s "$MCP_SYSTEM_TOKEN_FILE" ] || {
  echo "Token Sistema/Playground não encontrado em $MCP_SYSTEM_TOKEN_FILE" >&2
  exit 1
}

wait_for() {
  name="$1"
  url="$2"
  attempts=0
  until curl -fsS "$url" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 120 ]; then
      echo "$name não ficou disponível em $url" >&2
      exit 1
    fi
    sleep 2
  done
}

pull_model() {
  model="$1"
  echo "Garantindo modelo Ollama: $model"
  curl -fsS "$OLLAMA_URL/api/pull" \
    -H 'content-type: application/json' \
    -d "$(jq -cn --arg model "$model" '{model:$model,stream:false}')" >/dev/null
}

wait_for "Ollama" "$OLLAMA_URL/api/tags"
wait_for "Open WebUI" "$OPENWEBUI_URL/health"
pull_model "$OLLAMA_CHAT_MODEL"
[ "$OLLAMA_BUSINESS_MODEL" = "$OLLAMA_CHAT_MODEL" ] || pull_model "$OLLAMA_BUSINESS_MODEL"
pull_model "$OLLAMA_EMBEDDING_MODEL"

auth_payload="$(jq -cn --arg email "$WEBUI_ADMIN_EMAIL" --arg password "$WEBUI_ADMIN_PASSWORD" '{email:$email,password:$password}')"
auth_response="$(curl -fsS "$OPENWEBUI_URL/api/v1/auths/signin" -H 'content-type: application/json' -d "$auth_payload")"
token="$(printf '%s' "$auth_response" | jq -er '.token')"
authorization="Authorization: Bearer $token"

rag_payload="$(jq -cn \
  --arg reranking_model "$RAG_RERANKING_MODEL" \
  --argjson reranking_batch_size "$RAG_RERANKING_BATCH_SIZE" \
  --argjson top_k "$RAG_TOP_K" \
  --argjson top_k_reranker "$RAG_TOP_K_RERANKER" \
  '{
    ENABLE_RAG_HYBRID_SEARCH:true,
    RAG_RERANKING_ENGINE:"",
    RAG_RERANKING_MODEL:$reranking_model,
    RAG_RERANKING_BATCH_SIZE:$reranking_batch_size,
    TOP_K:$top_k,
    TOP_K_RERANKER:$top_k_reranker
  }')"
curl -fsS "$OPENWEBUI_URL/api/v1/retrieval/config/update" \
  -H "$authorization" \
  -H 'content-type: application/json' \
  -d "$rag_payload" >/dev/null
echo "RAG híbrido e reranking configurados"

knowledge_list="$(curl -fsS "$OPENWEBUI_URL/api/v1/knowledge/" -H "$authorization")"
knowledge_id="$(printf '%s' "$knowledge_list" | jq -r '(.items // .)[]? | select(.name == "Knowledge Base Sample") | .id' | head -n 1)"
if [ -z "$knowledge_id" ]; then
  knowledge_payload='{"name":"Knowledge Base Sample","description":"Base de conhecimento de exemplo para documentos corporativos processados pelo Docling.","access_grants":[]}'
  knowledge_response="$(curl -fsS "$OPENWEBUI_URL/api/v1/knowledge/create" -H "$authorization" -H 'content-type: application/json' -d "$knowledge_payload")"
  knowledge_id="$(printf '%s' "$knowledge_response" | jq -er '.id')"
  echo "Knowledge Base Sample criada"
else
  echo "Knowledge Base Sample já existe"
fi

mcp_system_token="$(tr -d '\r\n' < "$MCP_SYSTEM_TOKEN_FILE")"
[ -n "$mcp_system_token" ] || {
  echo "Token Sistema/Playground está vazio" >&2
  exit 1
}
mcp_admin_connection="$(jq -cn \
  --arg url "$MCP_ADMIN_URL" \
  --arg key "$mcp_system_token" \
  '{
    type:"mcp",
    url:$url,
    path:"",
    auth_type:"bearer",
    key:$key,
    headers:{},
    config:{enable:true},
    info:{
      id:"mcp-admin",
      name:"MCP Admin",
      description:"Conexão administrativa ativa com o Codebase Memory MCP. Usa o token Sistema/Playground e possui acesso total a todos os projetos e ferramentas."
    }
  }')"

# A verificação usa o próprio fluxo MCP do Open WebUI e impede que uma
# instalação conclua com URL ou token administrativo inválidos.
curl -fsS "$OPENWEBUI_URL/api/v1/configs/tool_servers/verify" \
  -H "$authorization" \
  -H 'content-type: application/json' \
  -d "$mcp_admin_connection" >/dev/null

tool_servers_response="$(curl -fsS "$OPENWEBUI_URL/api/v1/configs/tool_servers" -H "$authorization")"
tool_servers_payload="$(printf '%s' "$tool_servers_response" | jq \
  --argjson mcp_admin "$mcp_admin_connection" '
  .TOOL_SERVER_CONNECTIONS = (
    [(.TOOL_SERVER_CONNECTIONS // [])[] | select(.info.id != "mcp-admin" and .info.id != "mcp-tool-sample")]
    + [$mcp_admin]
  )')"
curl -fsS "$OPENWEBUI_URL/api/v1/configs/tool_servers" \
  -H "$authorization" \
  -H 'content-type: application/json' \
  -d "$tool_servers_payload" >/dev/null
unset mcp_system_token mcp_admin_connection tool_servers_payload
echo "MCP Admin validado, ativo e configurado com acesso total"

models_payload="$(jq --arg knowledge_id "$knowledge_id" --arg chat_model "$OLLAMA_CHAT_MODEL" --arg business_model "$OLLAMA_BUSINESS_MODEL" --argjson context_length "$OLLAMA_CONTEXT_LENGTH" '
  .models |= map(
    (if .id == "business-model-sample" then .base_model_id = $business_model else .base_model_id = $chat_model end)
    | .params.num_ctx = $context_length
    | if .id == "business-model-sample" then
        .meta.knowledge = [{id:$knowledge_id,name:"Knowledge Base Sample",type:"collection"}]
      else . end
  )' /bootstrap/models.json)"
curl -fsS "$OPENWEBUI_URL/api/v1/models/import" \
  -H "$authorization" \
  -H 'content-type: application/json' \
  -d "$models_payload" >/dev/null

echo "Presets de exemplo importados; bootstrap concluído"
