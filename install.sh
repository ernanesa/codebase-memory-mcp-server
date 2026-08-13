#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BASE_DIR="$SCRIPT_DIR"
REPOSITORIES_DIR="${BASE_DIR}/repositories"
CACHE_DIR="${BASE_DIR}/cache"
DATA_DIR="${BASE_DIR}/data"
AGENTGATEWAY_DATA_DIR="${DATA_DIR}/agentgateway"
ENV_FILE="${BASE_DIR}/.env"
GPU_COMPOSE_FILE="${BASE_DIR}/compose.gpu.yaml"
OLLAMA_COMPOSE_FILE="${BASE_DIR}/compose.ollama.yaml"
OLLAMA_LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.codebase-memory.ollama.plist"
CBM_BIN="${HOME}/.local/bin/codebase-memory-mcp"
CBM_CONTAINER_BIN="$CBM_BIN"
CBM_VERSION="v0.8.1"
INSTALL_URL="https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/${CBM_VERSION}/install.sh"
RELEASE_DOWNLOAD_URL="https://github.com/DeusData/codebase-memory-mcp/releases/download/${CBM_VERSION}"
CURRENT_USER="$(id -un)"
SUDO_KEEPALIVE_PID=''
ADMIN_PASSWORD=''
ADMIN_EMAIL=''
OPENWEBUI_PUBLIC_URL=''
ADMIN_PUBLIC_URL=''
GRAFANA_PUBLIC_URL=''
MCP_PUBLIC_URL=''
OPENWEBUI_ADMIN_NAME='Admin'
OPENWEBUI_PREVIOUS_EMAIL=''
OPENWEBUI_PREVIOUS_NAME=''
OPENWEBUI_PREVIOUS_PASSWORD=''
OPENWEBUI_DESIRED_PASSWORD=''
OLLAMA_VERSION='0.32.1'
OLLAMA_CHAT_MODEL='gemma4:e2b'
OLLAMA_KV_CACHE_QUANTIZATION='fp16'
OLLAMA_KEEP_ALIVE='5m'
OLLAMA_RUNTIME='docker'
OLLAMA_BASE_URL='http://ollama:11434'
OLLAMA_COMPOSE_PROFILES='ollama-docker'
OLLAMA_GPU_MODE='cpu'
OLLAMA_GPU_DEVICE_IDS=''
DOCLING_VERSION='v1.26.0'
DOCLING_CPU_THREADS='6'
RAG_RERANKING_MODEL='BAAI/bge-reranker-v2-m3'
RAG_RERANKING_BATCH_SIZE='4'
RAG_TOP_K='20'
RAG_TOP_K_RERANKER='8'
SYSTEM_PLATFORM=''
SYSTEM_ARCHITECTURE="$(uname -m)"
BREW_BIN=''
OLLAMA_BIN=''
ACTIVE_PHASE='Preparação'
CONFIG_TOTAL_STEPS=8

if [[ -t 1 ]]; then
  COLOR_BLUE='\033[0;34m'
  COLOR_CYAN='\033[0;36m'
  COLOR_GREEN='\033[0;32m'
  COLOR_RED='\033[0;31m'
  COLOR_YELLOW='\033[0;33m'
  COLOR_MUTED='\033[0;90m'
  COLOR_BOLD='\033[1m'
  COLOR_RESET='\033[0m'
else
  COLOR_BLUE='' COLOR_CYAN='' COLOR_GREEN='' COLOR_RED='' COLOR_YELLOW='' COLOR_MUTED='' COLOR_BOLD='' COLOR_RESET=''
fi

info() { printf "${COLOR_BLUE}ℹ${COLOR_RESET}  %s\n" "$*"; }
success() { printf "${COLOR_GREEN}✔${COLOR_RESET}  %s\n" "$*"; }
warn() { printf "${COLOR_YELLOW}⚠${COLOR_RESET}  %s\n" "$*"; }
fail() { printf "${COLOR_RED}✖  %s${COLOR_RESET}\n" "$*" >&2; exit 1; }

print_rule() {
  printf "${COLOR_MUTED}────────────────────────────────────────────────────────────${COLOR_RESET}\n"
}

show_welcome() {
  printf '\n'
  printf "${COLOR_CYAN}${COLOR_BOLD}  CODEBASE MEMORY${COLOR_RESET}\n"
  printf "${COLOR_BOLD}  Instalador do ambiente MCP${COLOR_RESET}\n"
  printf "${COLOR_MUTED}  Configuração guiada · %s${COLOR_RESET}\n\n" "$CBM_VERSION"
  print_rule
  printf '  Este assistente validará o sistema, coletará 7 configurações\n'
  printf '  e instalará todos os serviços. Seus dados são preservados\n'
  printf '  caso esta seja uma reinstalação.\n'
  print_rule
}

show_config_step() {
  local number="$1" title="$2" description="$3"
  ACTIVE_PHASE="Configuração — ${title}"
  printf "\n${COLOR_CYAN}${COLOR_BOLD}ETAPA %s DE %s${COLOR_RESET}  ${COLOR_MUTED}Configuração${COLOR_RESET}\n" "$number" "$CONFIG_TOTAL_STEPS"
  printf "${COLOR_BOLD}%s${COLOR_RESET}\n" "$title"
  printf "${COLOR_MUTED}%s${COLOR_RESET}\n\n" "$description"
}

show_install_phase() {
  local number="$1" title="$2" description="$3"
  ACTIVE_PHASE="$title"
  printf "\n${COLOR_CYAN}${COLOR_BOLD}FASE %s DE 4${COLOR_RESET}  ${COLOR_BOLD}%s${COLOR_RESET}\n" "$number" "$title"
  printf "${COLOR_MUTED}%s${COLOR_RESET}\n" "$description"
  print_rule
}

print_option() {
  local key="$1" label="$2" description="$3"
  printf "  ${COLOR_CYAN}${COLOR_BOLD}%s${COLOR_RESET}  %-24s ${COLOR_MUTED}%s${COLOR_RESET}\n" "$key" "$label" "$description"
}

prompt_value() {
  local label="$1"
  printf "${COLOR_CYAN}›${COLOR_RESET} ${COLOR_BOLD}%s${COLOR_RESET} " "$label" >&2
}

on_error() {
  printf "\n${COLOR_RED}${COLOR_BOLD}✖ Não foi possível concluir: %s${COLOR_RESET}\n" "$ACTIVE_PHASE" >&2
  printf "  A falha ocorreu na linha %s. Revise os detalhes acima e execute\n" "$1" >&2
  printf "  o instalador novamente; configurações e dados existentes serão preservados.\n" >&2
}
trap 'on_error "$LINENO"' ERR

cleanup() {
  ADMIN_PASSWORD=''
  OPENWEBUI_PREVIOUS_PASSWORD=''
  OPENWEBUI_DESIRED_PASSWORD=''
  if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    wait "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

run_step() {
  local message="$1"
  shift

  local log_file status spinner_pid=''
  log_file="$(mktemp "${TMPDIR:-/tmp}/cbm-install.XXXXXX")"

  "$@" >"$log_file" 2>&1 &
  local command_pid=$!

  if [[ -t 1 ]]; then
    (
      local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' index=0
      while kill -0 "$command_pid" 2>/dev/null; do
        printf "\r${COLOR_BLUE}%s${COLOR_RESET}  %s" "${frames:index++%${#frames}:1}" "$message"
        sleep 0.1
      done
    ) &
    spinner_pid=$!
  else
    info "$message"
  fi

  set +e
  wait "$command_pid"
  status=$?
  set -e

  if [[ -n "$spinner_pid" ]]; then
    wait "$spinner_pid" 2>/dev/null || true
    printf '\r\033[2K'
  fi

  if (( status != 0 )); then
    printf "${COLOR_RED}✖${COLOR_RESET}  %s\n" "$message" >&2
    sed 's/^/   /' "$log_file" >&2
    rm -f "$log_file"
    return "$status"
  fi

  rm -f "$log_file"
  success "$message"
}

detect_system_platform() {
  case "$(uname -s)" in
    Linux) printf 'linux\n' ;;
    Darwin) printf 'macos\n' ;;
    *) fail "Sistema não suportado: $(uname -s). Use Linux ou macOS." ;;
  esac
}

require_supported_system() {
  local macos_major macos_version
  (( EUID != 0 )) || fail "Execute este instalador como usuário comum, não como root."
  SYSTEM_PLATFORM="$(detect_system_platform)"

  if [[ "$SYSTEM_PLATFORM" == macos ]]; then
    macos_version="$(sw_vers -productVersion)"
    macos_major="${macos_version%%.*}"
    [[ "$macos_major" =~ ^[0-9]+$ ]] && (( macos_major >= 14 )) \
      || fail "O modo macOS requer macOS 14 (Sonoma) ou mais recente."
    if [[ "$SYSTEM_ARCHITECTURE" == x86_64 && "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
      SYSTEM_ARCHITECTURE='arm64'
    fi
    command -v sudo >/dev/null 2>&1 || fail "O comando sudo não está disponível."
    return
  fi

  [[ -f /etc/os-release ]] || fail "Não foi possível identificar a distribuição Linux."

  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != ubuntu && "${ID:-}" != debian && "${ID_LIKE:-}" != *debian* ]]; then
    fail "Sistema não suportado. Use Debian, Ubuntu ou uma distribuição compatível."
  fi

  command -v apt-get >/dev/null 2>&1 || fail "O comando apt-get não está disponível."
  command -v sudo >/dev/null 2>&1 || fail "O comando sudo não está disponível."
}

validate_sudo() {
  info "O sudo pode solicitar sua senha para instalar as dependências."
  sudo -v || fail "O usuário ${CURRENT_USER} não possui acesso ao sudo."
  success "Acesso ao sudo validado"
}

keep_sudo_alive() {
  (
    while true; do
      sudo -n true 2>/dev/null || true
      sleep 45
    done
  ) &
  SUDO_KEEPALIVE_PID=$!
}

validate_system_clock() {
  if command -v chronyc >/dev/null 2>&1; then
    chronyc tracking | awk -F: '
      /System time/ {
        gsub(/^[[:space:]]+/, "", $2)
        split($2, fields, /[[:space:]]+/)
        offset = fields[1] + 0
        if (offset < 0) offset = -offset
        found = 1
        if (offset > 60) exit 1
      }
      END { if (!found) exit 1 }
    ' || fail "O relógio do servidor está fora de sincronia. O instalador não altera a hora do host. Corrija com 'sudo chronyc -a makestep', valide com 'chronyc tracking' e execute novamente."
    success "Relógio do sistema validado pelo Chrony"
    return
  fi

  if command -v timedatectl >/dev/null 2>&1; then
    if [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != yes ]]; then
      warn "O sistema não informa sincronização NTP ativa; o APT validará as datas dos repositórios."
    fi
  fi
}

install_linux_dependencies() {
  validate_system_clock
  run_step "Atualizando a lista de pacotes" sudo apt-get update
  run_step "Instalando dependências do sistema" sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y ca-certificates curl git gnupg jq openssh-client openssl util-linux docker.io

  if ! docker compose version >/dev/null 2>&1 && ! sudo docker compose version >/dev/null 2>&1; then
    if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
      run_step "Instalando Docker Compose" sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y docker-compose-v2
    else
      run_step "Instalando Docker Compose" sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y docker-compose-plugin
    fi
  fi

  local command_name
  for command_name in bash curl git jq flock ssh openssl docker; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Dependência não encontrada: ${command_name}"
  done

  if ! sudo docker info >/dev/null 2>&1; then
    run_step "Iniciando o serviço do Docker" sudo systemctl enable --now docker
  fi
}

configure_homebrew_path() {
  local candidate
  if command -v brew >/dev/null 2>&1; then
    BREW_BIN="$(command -v brew)"
  else
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [[ -x "$candidate" ]]; then
        BREW_BIN="$candidate"
        break
      fi
    done
  fi
  if [[ -n "$BREW_BIN" ]]; then
    export PATH="$($BREW_BIN --prefix)/bin:$($BREW_BIN --prefix)/sbin:$PATH"
  fi
}

install_homebrew() {
  configure_homebrew_path
  if [[ -n "$BREW_BIN" ]]; then
    success "Homebrew já está instalado"
    return
  fi

  info "Instalando Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  configure_homebrew_path
  [[ -n "$BREW_BIN" ]] || fail "O Homebrew não foi encontrado após a instalação."
  success "Homebrew instalado"
}

wait_for_docker_desktop() {
  local attempt
  if docker info >/dev/null 2>&1; then
    return
  fi
  open -ga Docker || fail "Não foi possível iniciar o Docker Desktop."
  for attempt in {1..120}; do
    if docker info >/dev/null 2>&1; then
      success "Docker Desktop está ativo"
      return
    fi
    sleep 2
  done
  fail "O Docker Desktop não ficou disponível. Conclua a configuração inicial do aplicativo e execute novamente o instalador."
}

install_macos_dependencies() {
  local -a brew_packages=()
  install_homebrew

  command -v jq >/dev/null 2>&1 || brew_packages+=(jq)
  command -v git >/dev/null 2>&1 || brew_packages+=(git)
  if (( ${#brew_packages[@]} > 0 )); then
    run_step "Instalando dependências pelo Homebrew" "$BREW_BIN" install "${brew_packages[@]}"
  fi

  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    run_step "Instalando Docker Desktop" "$BREW_BIN" install --cask docker-desktop
    configure_homebrew_path
  fi

  local command_name
  for command_name in bash curl git jq ssh openssl docker; do
    command -v "$command_name" >/dev/null 2>&1 || fail "Dependência não encontrada: ${command_name}"
  done
  docker compose version >/dev/null 2>&1 || fail "O plugin Docker Compose não está disponível."
  wait_for_docker_desktop
}

install_dependencies() {
  if [[ "$SYSTEM_PLATFORM" == macos ]]; then
    install_macos_dependencies
  else
    install_linux_dependencies
  fi
}

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

configure_host_ollama_command() {
  local ollama_bin ollama_bin_xml log_file log_file_xml user_domain
  ollama_bin="$OLLAMA_BIN"
  [[ -x "$ollama_bin" ]] || fail 'O executável do Ollama não está disponível para o LaunchAgent.'
  log_file="${HOME}/Library/Logs/CodebaseMemoryOllama.log"
  ollama_bin_xml="$(printf '%s' "$ollama_bin" | xml_escape)"
  log_file_xml="$(printf '%s' "$log_file" | xml_escape)"
  user_domain="gui/$(id -u)"

  mkdir -p "$(dirname "$OLLAMA_LAUNCH_AGENT")" "$(dirname "$log_file")"
  if [[ -n "$BREW_BIN" ]] && "$BREW_BIN" list --formula ollama >/dev/null 2>&1; then
    "$BREW_BIN" services stop ollama >/dev/null 2>&1 || true
  fi
  osascript -e 'tell application "Ollama" to quit' >/dev/null 2>&1 || true
  launchctl bootout "${user_domain}/com.codebase-memory.ollama" >/dev/null 2>&1 || true
  launchctl bootout "$user_domain" "$OLLAMA_LAUNCH_AGENT" >/dev/null 2>&1 || true

  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '%s\n' '  <key>Label</key>'
    printf '%s\n' '  <string>com.codebase-memory.ollama</string>'
    printf '%s\n' '  <key>ProgramArguments</key>'
    printf '%s\n' '  <array>'
    printf '    <string>%s</string>\n' "$ollama_bin_xml"
    printf '%s\n' '    <string>serve</string>'
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>EnvironmentVariables</key>'
    printf '%s\n' '  <dict>'
    printf '%s\n' '    <key>OLLAMA_HOST</key>'
    printf '%s\n' '    <string>0.0.0.0:11434</string>'
    printf '%s\n' '    <key>OLLAMA_KEEP_ALIVE</key>'
    printf '    <string>%s</string>\n' "$OLLAMA_KEEP_ALIVE"
    if [[ "$OLLAMA_KEEP_ALIVE" == '-1' ]]; then
      printf '%s\n' '    <key>OLLAMA_MAX_LOADED_MODELS</key>'
      printf '%s\n' '    <string>2</string>'
    fi
    if [[ "$OLLAMA_KV_CACHE_QUANTIZATION" == q8_0 ]]; then
      printf '%s\n' '    <key>OLLAMA_FLASH_ATTENTION</key>'
      printf '%s\n' '    <string>1</string>'
      printf '%s\n' '    <key>OLLAMA_KV_CACHE_TYPE</key>'
      printf '%s\n' '    <string>q8_0</string>'
    fi
    printf '%s\n' '  </dict>'
    printf '%s\n' '  <key>RunAtLoad</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>KeepAlive</key>'
    printf '%s\n' '  <true/>'
    printf '%s\n' '  <key>StandardOutPath</key>'
    printf '  <string>%s</string>\n' "$log_file_xml"
    printf '%s\n' '  <key>StandardErrorPath</key>'
    printf '  <string>%s</string>\n' "$log_file_xml"
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } >"${OLLAMA_LAUNCH_AGENT}.tmp"
  plutil -lint "${OLLAMA_LAUNCH_AGENT}.tmp" >/dev/null
  chmod 600 "${OLLAMA_LAUNCH_AGENT}.tmp"
  mv "${OLLAMA_LAUNCH_AGENT}.tmp" "$OLLAMA_LAUNCH_AGENT"
  launchctl bootstrap "$user_domain" "$OLLAMA_LAUNCH_AGENT"
  launchctl kickstart -k "${user_domain}/com.codebase-memory.ollama"
}

install_host_ollama() {
  local attempt
  [[ "$OLLAMA_RUNTIME" == host ]] || return 0
  [[ "$SYSTEM_PLATFORM" == macos ]] || fail 'O modo host do Ollama requer macOS.'
  configure_homebrew_path
  [[ -n "$BREW_BIN" ]] || fail 'Homebrew não está disponível para instalar o Ollama.'

  if command -v ollama >/dev/null 2>&1; then
    OLLAMA_BIN="$(command -v ollama)"
    success "Ollama já está instalado"
  elif [[ -x /Applications/Ollama.app/Contents/Resources/ollama ]]; then
    OLLAMA_BIN='/Applications/Ollama.app/Contents/Resources/ollama'
    success "Ollama já está instalado"
  else
    run_step "Instalando Ollama pelo Homebrew" "$BREW_BIN" install ollama
    configure_homebrew_path
    OLLAMA_BIN="$(command -v ollama)"
  fi
  [[ -x "$OLLAMA_BIN" ]] || fail 'O executável do Ollama não foi encontrado.'

  warn 'O Ollama escutará em 0.0.0.0:11434 para permitir o acesso dos containers; restrinja essa porta no firewall local.'
  run_step "Configurando o Ollama como serviço nativo" configure_host_ollama_command
  for attempt in {1..60}; do
    if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      success "Ollama nativo está disponível"
      return
    fi
    sleep 2
  done
  fail "O Ollama nativo não ficou disponível. Consulte ${HOME}/Library/Logs/CodebaseMemoryOllama.log."
}

configure_nvidia_runtime_command() {
  local daemon_config='/etc/docker/daemon.json'
  local daemon_config_backup='/etc/docker/daemon.json.codebase-memory-backup'
  local daemon_config_candidate
  local cgroup_driver cgroup_version
  [[ "$OLLAMA_GPU_MODE" != cpu ]] || return 0
  command -v nvidia-smi >/dev/null 2>&1 || fail 'A GPU foi habilitada, mas o driver NVIDIA não está disponível.'
  nvidia-smi -L >/dev/null || fail 'A GPU foi habilitada, mas o driver NVIDIA não respondeu.'

  if ! command -v nvidia-ctk >/dev/null 2>&1; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor --yes -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y nvidia-container-toolkit
  fi

  sudo nvidia-ctk runtime configure --runtime=docker
  cgroup_driver="$(sudo docker info --format '{{.CgroupDriver}}' 2>/dev/null || true)"
  cgroup_version="$(sudo docker info --format '{{.CgroupVersion}}' 2>/dev/null || true)"
  if [[ "$cgroup_driver" == systemd && "$cgroup_version" == 2 ]]; then
    info 'Aplicando cgroupfs para evitar que containers NVIDIA percam acesso à GPU após reloads do systemd'
    daemon_config_candidate="$(mktemp "${TMPDIR:-/tmp}/cbm-docker-daemon.XXXXXX")"
    sudo test ! -f "$daemon_config" || sudo cat "$daemon_config" >"$daemon_config_candidate"
    [[ -s "$daemon_config_candidate" ]] || printf '{}\n' >"$daemon_config_candidate"
    jq '."exec-opts" = (((."exec-opts" // []) + ["native.cgroupdriver=cgroupfs"]) | unique)' \
      "$daemon_config_candidate" >"${daemon_config_candidate}.merged"
    mv "${daemon_config_candidate}.merged" "$daemon_config_candidate"
    sudo dockerd --validate --config-file="$daemon_config_candidate" >/dev/null
    sudo test ! -f "$daemon_config" || sudo cp "$daemon_config" "$daemon_config_backup"
    sudo install -m 0644 "$daemon_config_candidate" "$daemon_config"
    rm -f "$daemon_config_candidate"
  fi

  if ! sudo systemctl restart docker; then
    if sudo test -f "$daemon_config_backup"; then
      warn 'O Docker não reiniciou; restaurando a configuração anterior.'
      sudo cp "$daemon_config_backup" "$daemon_config"
      sudo systemctl restart docker
    fi
    fail 'Não foi possível reiniciar o Docker após configurar o runtime NVIDIA.'
  fi
  sudo docker info >/dev/null
  if [[ "$cgroup_driver" == systemd && "$cgroup_version" == 2 ]]; then
    [[ "$(sudo docker info --format '{{.CgroupDriver}}')" == cgroupfs ]] || \
      fail 'O Docker reiniciou, mas não adotou o cgroup driver cgroupfs.'
  fi
}

ask_memory_budget() {
  local choice custom_value existing_budget default_choice
  existing_budget="$(read_existing_environment_value CBM_MEM_BUDGET_MB)"
  [[ "$existing_budget" =~ ^[1-9][0-9]*$ ]] || existing_budget='8192'

  case "$existing_budget" in
    4096) default_choice=1 ;;
    8192) default_choice=2 ;;
    16384) default_choice=3 ;;
    32768) default_choice=4 ;;
    *) default_choice=5 ;;
  esac

  show_config_step 1 'Memória disponível' 'Defina quanto de RAM o Codebase Memory pode usar durante a indexação.'
  printf "${COLOR_MUTED}Os demais serviços também consomem memória. Recomendamos reservar\n"
  printf "aproximadamente metade da RAM da máquina para o Codebase Memory.${COLOR_RESET}\n\n"
  print_option 1 '4 GB' 'Para máquinas com 8 GB de RAM'
  print_option 2 '8 GB' 'Recomendado para máquinas com 16 GB'
  print_option 3 '16 GB' 'Recomendado para máquinas com 32 GB'
  print_option 4 '32 GB' 'Recomendado para máquinas com 64 GB ou mais'
  print_option 5 'Valor personalizado' 'Informe o limite em MB'
  printf '\n'

  while true; do
    prompt_value "Escolha [1-5] (padrão: ${default_choice}):"
    read -r choice
    case "${choice:-$default_choice}" in
      1) CBM_MEM_BUDGET_MB=4096; break ;;
      2) CBM_MEM_BUDGET_MB=8192; break ;;
      3) CBM_MEM_BUDGET_MB=16384; break ;;
      4) CBM_MEM_BUDGET_MB=32768; break ;;
      5)
        while true; do
          prompt_value "Memória em MB (atual: ${existing_budget}):"
          read -r custom_value
          custom_value="${custom_value:-$existing_budget}"
          if [[ "$custom_value" =~ ^[1-9][0-9]*$ ]]; then
            CBM_MEM_BUDGET_MB="$custom_value"
            break 2
          fi
          warn "Informe um número inteiro maior que zero."
        done
        ;;
      *) warn "Opção inválida. Escolha um número entre 1 e 5." ;;
    esac
  done

  success "Limite de memória definido em ${CBM_MEM_BUDGET_MB} MB"
}

ask_ollama_runtime() {
  local choice default_choice existing_runtime
  existing_runtime="$(read_existing_environment_value OLLAMA_RUNTIME)"

  if [[ "$existing_runtime" == docker || ( "$existing_runtime" == host && "$SYSTEM_PLATFORM" == macos ) ]]; then
    OLLAMA_RUNTIME="$existing_runtime"
  elif [[ "$SYSTEM_PLATFORM" == macos ]]; then
    OLLAMA_RUNTIME='host'
  else
    OLLAMA_RUNTIME='docker'
  fi

  show_config_step 2 'Execução do Ollama' 'Escolha onde o modelo local será executado.'
  print_option 1 'Docker' 'Isolado e recomendado no Linux'
  if [[ "$SYSTEM_PLATFORM" == macos ]]; then
    print_option 2 'Host macOS' 'Homebrew e aceleração nativa no Apple Silicon'
  else
    print_option 2 'Host macOS' 'Disponível somente no macOS'
  fi
  printf '\n'

  [[ "$OLLAMA_RUNTIME" == host ]] && default_choice=2 || default_choice=1
  while true; do
    prompt_value "Escolha [1-2] (padrão: ${default_choice}):"
    read -r choice
    case "${choice:-$default_choice}" in
      1)
        OLLAMA_RUNTIME='docker'
        OLLAMA_BASE_URL='http://ollama:11434'
        OLLAMA_COMPOSE_PROFILES='ollama-docker'
        break
        ;;
      2)
        [[ "$SYSTEM_PLATFORM" == macos ]] || {
          warn 'O modo host é suportado somente no macOS.'
          continue
        }
        OLLAMA_RUNTIME='host'
        OLLAMA_BASE_URL='http://host.docker.internal:11434'
        OLLAMA_COMPOSE_PROFILES=''
        break
        ;;
      *) warn 'Opção inválida. Escolha 1 ou 2.' ;;
    esac
  done

  if [[ "$OLLAMA_RUNTIME" == host ]]; then
    success 'Ollama será executado nativamente no macOS'
  else
    success 'Ollama será executado pelo Docker'
  fi
}

ask_ollama_model() {
  local choice custom_model existing_model
  existing_model="$(read_existing_environment_value OLLAMA_CHAT_MODEL)"
  OLLAMA_CHAT_MODEL="${existing_model:-gemma4:e2b}"

  show_config_step 3 'Modelo de linguagem' 'Selecione o modelo de chat que será baixado pelo Ollama.'
  print_option 1 'gemma4:e2b' 'Mais leve e rápido'
  print_option 2 'gemma4:e4b (Gemma 4 Effective 4B)' 'Mais capacidade e maior consumo de recursos'
  print_option 3 'Outro modelo' 'Use um identificador disponível no Ollama'
  printf '\n'

  while true; do
    prompt_value "Escolha [1-3] (atual: ${OLLAMA_CHAT_MODEL}):"
    read -r choice
    if [[ -z "$choice" ]]; then
      break
    fi
    case "$choice" in
      1) OLLAMA_CHAT_MODEL='gemma4:e2b'; break ;;
      2) OLLAMA_CHAT_MODEL='gemma4:e4b'; break ;;
      3)
        prompt_value 'Identificador do modelo (ex.: gemma4:12b):'
        read -r custom_model
        if [[ "$custom_model" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?$ ]]; then
          OLLAMA_CHAT_MODEL="$custom_model"
          break
        fi
        warn 'Identificador inválido para um modelo Ollama.'
        ;;
      *) warn 'Opção inválida. Escolha um número entre 1 e 3.' ;;
    esac
  done
  success "Modelo selecionado: ${OLLAMA_CHAT_MODEL}"
}

ask_ollama_quantization() {
  local choice default_choice existing_quantization
  existing_quantization="$(read_existing_environment_value OLLAMA_KV_CACHE_QUANTIZATION)"
  case "$existing_quantization" in
    fp16|q8_0) OLLAMA_KV_CACHE_QUANTIZATION="$existing_quantization" ;;
    *) OLLAMA_KV_CACHE_QUANTIZATION='fp16' ;;
  esac

  show_config_step 4 'Quantização do cache K/V' 'Escolha o equilíbrio entre precisão e consumo de memória do Ollama.'
  print_option 1 'fp16' 'Maior precisão e uso de memória; padrão do Ollama'
  print_option 2 'q8_0' 'Aproximadamente metade da memória, com pequena perda de precisão'
  printf '\n'

  [[ "$OLLAMA_KV_CACHE_QUANTIZATION" == q8_0 ]] && default_choice=2 || default_choice=1
  while true; do
    prompt_value "Escolha [1-2] (padrão: ${default_choice}):"
    read -r choice
    case "${choice:-$default_choice}" in
      1) OLLAMA_KV_CACHE_QUANTIZATION='fp16'; break ;;
      2) OLLAMA_KV_CACHE_QUANTIZATION='q8_0'; break ;;
      *) warn 'Opção inválida. Escolha 1 ou 2.' ;;
    esac
  done

  success "Quantização do cache K/V: ${OLLAMA_KV_CACHE_QUANTIZATION}"
}

ask_ollama_keep_alive() {
  local choice default_choice existing_keep_alive
  existing_keep_alive="$(read_existing_environment_value OLLAMA_KEEP_ALIVE)"
  case "$existing_keep_alive" in
    -1|30m|5m) OLLAMA_KEEP_ALIVE="$existing_keep_alive" ;;
    *) OLLAMA_KEEP_ALIVE='5m' ;;
  esac

  show_config_step 5 'Residência dos modelos' 'Defina por quanto tempo os modelos permanecem carregados na memória da GPU.'
  print_option 1 'Sempre' 'Recomendado para servidor dedicado; mantém até dois modelos carregados'
  print_option 2 '30 minutos' 'Equilíbrio entre latência e liberação de VRAM'
  print_option 3 '5 minutos' 'Comportamento padrão do Ollama'
  printf '\n'

  case "$OLLAMA_KEEP_ALIVE" in
    -1) default_choice=1 ;;
    30m) default_choice=2 ;;
    *) default_choice=3 ;;
  esac
  while true; do
    prompt_value "Escolha [1-3] (padrão: ${default_choice}):"
    read -r choice
    case "${choice:-$default_choice}" in
      1) OLLAMA_KEEP_ALIVE='-1'; break ;;
      2) OLLAMA_KEEP_ALIVE='30m'; break ;;
      3) OLLAMA_KEEP_ALIVE='5m'; break ;;
      *) warn 'Opção inválida. Escolha um número entre 1 e 3.' ;;
    esac
  done

  [[ "$OLLAMA_KEEP_ALIVE" == '-1' ]] && \
    success 'Os modelos permanecerão carregados; limite simultâneo: 2' || \
    success "Os modelos permanecerão carregados por ${OLLAMA_KEEP_ALIVE}"
}

ask_ollama_gpu() {
  local existing_mode existing_devices existing_indices='' choice default_choice record index uuid name memory selection token selected_ids='' selected_uuid position
  local -a gpu_records=() requested_indices=() gpu_indices=() gpu_uuids=()

  existing_mode="$(read_existing_environment_value OLLAMA_GPU_MODE)"
  existing_devices="$(read_existing_environment_value OLLAMA_GPU_DEVICE_IDS)"
  OLLAMA_GPU_MODE='cpu'
  OLLAMA_GPU_DEVICE_IDS=''

  show_config_step 6 'Aceleração de hardware' 'O instalador detectará automaticamente os recursos disponíveis.'

  if [[ "$OLLAMA_RUNTIME" == host ]]; then
    if [[ "$SYSTEM_ARCHITECTURE" == arm64 || "$SYSTEM_ARCHITECTURE" == aarch64 ]]; then
      OLLAMA_GPU_MODE='metal'
      success 'Ollama nativo usará a aceleração do Apple Silicon'
    else
      OLLAMA_GPU_MODE='cpu'
      success 'Ollama nativo usará CPU neste Mac'
    fi
    return
  fi

  if ! command -v nvidia-smi >/dev/null 2>&1; then
    info 'Nenhuma GPU NVIDIA foi detectada; o Ollama usará CPU.'
    return
  fi
  while IFS= read -r record; do
    [[ -z "$record" ]] || gpu_records+=("$record")
  done < <(nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv,noheader,nounits 2>/dev/null || true)
  if (( ${#gpu_records[@]} == 0 )); then
    warn 'O nvidia-smi não encontrou GPUs utilizáveis; o Ollama usará CPU.'
    return
  fi

  printf "${COLOR_BOLD}GPUs NVIDIA detectadas${COLOR_RESET}\n\n"
  for record in "${gpu_records[@]}"; do
    IFS=',' read -r index uuid name memory <<<"$record"
    index="${index//[[:space:]]/}"
    uuid="${uuid#${uuid%%[![:space:]]*}}"; uuid="${uuid%${uuid##*[![:space:]]}}"
    name="${name#${name%%[![:space:]]*}}"; name="${name%${name##*[![:space:]]}}"
    memory="${memory//[[:space:]]/}"
    gpu_indices+=("$index")
    gpu_uuids+=("$uuid")
    if [[ ",${existing_devices}," == *",${uuid},"* ]]; then
      existing_indices="${existing_indices:+${existing_indices},}${index}"
    fi
    printf '  GPU %s — %s — %s MiB — %s\n' "$index" "$name" "$memory" "$uuid"
  done
  printf '\n'
  print_option 1 'Todas as GPUs' 'Maior capacidade disponível'
  print_option 2 'Selecionar GPUs' 'Controle quais dispositivos serão usados'
  print_option 3 'Somente CPU' 'Não disponibilizar GPUs ao Ollama'
  printf '\n'

  case "$existing_mode" in
    all) default_choice=1 ;;
    selected) default_choice=2 ;;
    *) default_choice=3 ;;
  esac
  while true; do
    prompt_value "Escolha [1-3] (padrão: ${default_choice}):"
    read -r choice
    case "${choice:-$default_choice}" in
      1)
        OLLAMA_GPU_MODE='all'
        OLLAMA_GPU_DEVICE_IDS=''
        break
        ;;
      2)
        prompt_value "Índices separados por vírgula${existing_indices:+ (atual: ${existing_indices})}:"
        read -r selection
        selection="${selection:-$existing_indices}"
        selected_ids=''
        IFS=',' read -ra requested_indices <<<"$selection"
        for token in "${requested_indices[@]}"; do
          token="${token//[[:space:]]/}"
          selected_uuid=''
          if [[ "$token" =~ ^[0-9]+$ ]]; then
            for position in "${!gpu_indices[@]}"; do
              if [[ "${gpu_indices[$position]}" == "$token" ]]; then
                selected_uuid="${gpu_uuids[$position]}"
                break
              fi
            done
          fi
          if [[ -z "$selected_uuid" ]]; then
            selected_ids=''
            break
          fi
          if [[ ",${selected_ids}," != *",${selected_uuid},"* ]]; then
            selected_ids="${selected_ids:+${selected_ids},}${selected_uuid}"
          fi
        done
        if [[ -n "$selected_ids" ]]; then
          OLLAMA_GPU_MODE='selected'
          OLLAMA_GPU_DEVICE_IDS="$selected_ids"
          break
        fi
        warn 'Seleção inválida. Use somente os índices exibidos, separados por vírgula.'
        ;;
      3)
        OLLAMA_GPU_MODE='cpu'
        OLLAMA_GPU_DEVICE_IDS=''
        break
        ;;
      *) warn 'Opção inválida. Escolha um número entre 1 e 3.' ;;
    esac
  done

  case "$OLLAMA_GPU_MODE" in
    all) success 'Ollama configurado para usar todas as GPUs NVIDIA' ;;
    selected) success "Ollama configurado para usar: ${OLLAMA_GPU_DEVICE_IDS}" ;;
    cpu) success 'Ollama configurado para usar somente CPU' ;;
  esac
}

read_existing_environment_value() {
  local variable_name="$1"
  if [[ -f "$ENV_FILE" ]]; then
    sed -n "s/^${variable_name}=//p" "$ENV_FILE" | tail -n 1
  fi
}

ask_proxy_access() {
  local suggested_email input password_confirmation
  if [[ -f "${DATA_DIR}/secrets/openwebui.env" ]]; then
    OPENWEBUI_PREVIOUS_EMAIL="$(sed -n 's/^WEBUI_ADMIN_EMAIL=//p' "${DATA_DIR}/secrets/openwebui.env" | tail -n 1)"
    OPENWEBUI_PREVIOUS_NAME="$(sed -n 's/^WEBUI_ADMIN_NAME=//p' "${DATA_DIR}/secrets/openwebui.env" | tail -n 1)"
    OPENWEBUI_PREVIOUS_PASSWORD="$(sed -n 's/^WEBUI_ADMIN_PASSWORD=//p' "${DATA_DIR}/secrets/openwebui.env" | tail -n 1)"
  fi
  suggested_email="${OPENWEBUI_PREVIOUS_EMAIL:-$(read_existing_environment_value ADMIN_EMAIL)}"
  [[ "$suggested_email" == *@*.* ]] || suggested_email='joao@exemplo.com'

  show_config_step 7 'Acesso administrativo' 'Esta credencial será usada no painel, no Open WebUI e no Grafana.'
  printf "${COLOR_MUTED}A senha não será exibida durante a digitação.${COLOR_RESET}\n\n"
  while true; do
    prompt_value "E-mail administrativo (padrão: ${suggested_email}):"
    read -r input
    ADMIN_EMAIL="${input:-$suggested_email}"
    if [[ "$ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
      break
    fi
    warn "Informe um endereço de e-mail válido."
  done
  ADMIN_USERNAME="$ADMIN_EMAIL"

  while true; do
    if [[ -s "${DATA_DIR}/secrets/openwebui.env" && "$ADMIN_EMAIL" == "$OPENWEBUI_PREVIOUS_EMAIL" ]]; then
      prompt_value 'Nova senha (Enter mantém a senha atual):'
      read -r -s ADMIN_PASSWORD
      printf '\n'
      [[ -z "$ADMIN_PASSWORD" ]] && break
    else
      prompt_value 'Senha administrativa (mínimo de 6 caracteres):'
      read -r -s ADMIN_PASSWORD
      printf '\n'
    fi

    if (( ${#ADMIN_PASSWORD} < 6 )); then
      warn "A senha precisa ter pelo menos 6 caracteres."
      continue
    fi
    prompt_value 'Confirme a senha:'
    read -r -s password_confirmation
    printf '\n'
    if [[ "$ADMIN_PASSWORD" == "$password_confirmation" ]]; then
      break
    fi
    warn "As senhas não coincidem."
  done

  if [[ -n "$ADMIN_PASSWORD" ]]; then
    OPENWEBUI_DESIRED_PASSWORD="$ADMIN_PASSWORD"
  else
    OPENWEBUI_DESIRED_PASSWORD="$OPENWEBUI_PREVIOUS_PASSWORD"
  fi
  [[ -n "$OPENWEBUI_DESIRED_PASSWORD" ]] || fail "A senha atual do Open WebUI não foi encontrada; informe uma nova senha."

  success "Credencial de acesso definida para ${ADMIN_EMAIL}"
}

public_url_host() {
  local authority="${1#*://}"
  printf '%s' "${authority%%:*}"
}

ask_public_url() {
  local variable_name="$1" label="$2" suggested="$3" input authority port port_number
  while true; do
    prompt_value "${label} (padrão: ${suggested}):"
    read -r input
    input="${input:-$suggested}"
    input="${input%/}"
    if [[ "$input" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
      authority="${input#*://}"
      if [[ "$authority" == *:* ]]; then
        port="${authority##*:}"
        port_number=$((10#$port))
        if (( port_number < 1 || port_number > 65535 )); then
          warn 'A porta da URL precisa estar entre 1 e 65535.'
          continue
        fi
      fi
      printf -v "$variable_name" '%s' "$input"
      return
    fi
    warn 'Informe uma URL HTTP ou HTTPS sem caminho, consulta, fragmento ou barra final.'
  done
}

ask_public_urls() {
  local legacy_public_url openwebui_suggested admin_suggested grafana_suggested mcp_suggested
  legacy_public_url="$(read_existing_environment_value PUBLIC_BASE_URL)"
  openwebui_suggested="$(read_existing_environment_value OPENWEBUI_PUBLIC_URL)"
  admin_suggested="$(read_existing_environment_value ADMIN_PUBLIC_URL)"
  grafana_suggested="$(read_existing_environment_value GRAFANA_PUBLIC_URL)"
  mcp_suggested="$(read_existing_environment_value MCP_PUBLIC_URL)"
  [[ -n "$openwebui_suggested" ]] || openwebui_suggested="${legacy_public_url:-http://openwebui.localhost:8080}"
  admin_suggested="${admin_suggested:-http://admin.localhost:8080}"
  grafana_suggested="${grafana_suggested:-http://grafana.localhost:8080}"
  mcp_suggested="${mcp_suggested:-http://mcp.localhost:8080}"

  show_config_step 8 'Endereços públicos' 'Cada serviço público usa um hostname próprio e opera na raiz, sem prefixo de caminho.'
  printf "${COLOR_MUTED}Use somente protocolo, domínio e porta opcional. Em produção, informe\n"
  printf "as quatro origens HTTPS publicadas pelo túnel.${COLOR_RESET}\n\n"
  ask_public_url OPENWEBUI_PUBLIC_URL 'Open WebUI' "$openwebui_suggested"
  ask_public_url ADMIN_PUBLIC_URL 'Painel administrativo' "$admin_suggested"
  ask_public_url GRAFANA_PUBLIC_URL 'Grafana' "$grafana_suggested"
  ask_public_url MCP_PUBLIC_URL 'Endpoint MCP' "$mcp_suggested"

  if [[ "$(public_url_host "$OPENWEBUI_PUBLIC_URL")" == "$(public_url_host "$ADMIN_PUBLIC_URL")" ||
        "$(public_url_host "$OPENWEBUI_PUBLIC_URL")" == "$(public_url_host "$GRAFANA_PUBLIC_URL")" ||
        "$(public_url_host "$OPENWEBUI_PUBLIC_URL")" == "$(public_url_host "$MCP_PUBLIC_URL")" ||
        "$(public_url_host "$ADMIN_PUBLIC_URL")" == "$(public_url_host "$GRAFANA_PUBLIC_URL")" ||
        "$(public_url_host "$ADMIN_PUBLIC_URL")" == "$(public_url_host "$MCP_PUBLIC_URL")" ||
        "$(public_url_host "$GRAFANA_PUBLIC_URL")" == "$(public_url_host "$MCP_PUBLIC_URL")" ]]; then
    fail 'Open WebUI, painel, Grafana e MCP precisam usar hostnames distintos.'
  fi
  success 'Quatro origens públicas configuradas'
}

confirm_configuration() {
  local answer ollama_execution ollama_acceleration
  [[ "$OLLAMA_RUNTIME" == host ]] && ollama_execution='Host macOS' || ollama_execution='Docker'
  case "$OLLAMA_GPU_MODE" in
    all) ollama_acceleration='Todas as GPUs NVIDIA' ;;
    selected) ollama_acceleration="GPUs ${OLLAMA_GPU_DEVICE_IDS}" ;;
    metal) ollama_acceleration='Apple Metal' ;;
    *) ollama_acceleration='CPU' ;;
  esac

  ACTIVE_PHASE='Revisão da configuração'
  printf "\n${COLOR_CYAN}${COLOR_BOLD}REVISÃO${COLOR_RESET}  ${COLOR_MUTED}Confira antes de continuar${COLOR_RESET}\n"
  print_rule
  printf '  Memória        %s MB\n' "$CBM_MEM_BUDGET_MB"
  printf '  Ollama         %s\n' "$ollama_execution"
  printf '  Modelo         %s\n' "$OLLAMA_CHAT_MODEL"
  printf '  Cache K/V      %s\n' "$OLLAMA_KV_CACHE_QUANTIZATION"
  printf '  Modelos em RAM %s\n' "$OLLAMA_KEEP_ALIVE"
  printf '  Aceleração     %s\n' "$ollama_acceleration"
  printf '  Administrador  %s\n' "$ADMIN_EMAIL"
  printf '  Open WebUI     %s\n' "$OPENWEBUI_PUBLIC_URL"
  printf '  Painel         %s\n' "$ADMIN_PUBLIC_URL"
  printf '  Grafana        %s\n' "$GRAFANA_PUBLIC_URL"
  printf '  MCP            %s\n' "$MCP_PUBLIC_URL"
  print_rule
  printf "${COLOR_MUTED}A partir daqui, o instalador poderá solicitar sua senha do sudo e\n"
  printf "seguirá sem novas perguntas.${COLOR_RESET}\n\n"

  while true; do
    prompt_value 'Iniciar a instalação? [S/n]:'
    read -r answer
    case "${answer:-s}" in
      s|S|sim|SIM|Sim) return 0 ;;
      n|N|nao|NAO|Nao|não|NÃO|Não) return 1 ;;
      *) warn 'Responda S para continuar ou N para cancelar.' ;;
    esac
  done
}

create_local_structure() {
  mkdir -p "$REPOSITORIES_DIR" "$CACHE_DIR" "$DATA_DIR" "${DATA_DIR}/bin" "$AGENTGATEWAY_DATA_DIR" "${DATA_DIR}/knowledge-sync" "${DATA_DIR}/secrets/knowledge-sync"
  chmod 755 "$REPOSITORIES_DIR"
  chmod 700 "$CACHE_DIR" "$DATA_DIR" "${DATA_DIR}/bin" "${DATA_DIR}/secrets" "$AGENTGATEWAY_DATA_DIR" "${DATA_DIR}/knowledge-sync" "${DATA_DIR}/secrets/knowledge-sync"
  success "Estrutura local criada em ${BASE_DIR}"
}

write_ollama_gpu_compose_override() {
  local temporary_file="${GPU_COMPOSE_FILE}.tmp" device_id
  local -a device_ids=()
  if [[ "$OLLAMA_RUNTIME" != docker ]]; then
    rm -f "$GPU_COMPOSE_FILE" "$temporary_file"
    success 'Override NVIDIA não é necessário para o Ollama nativo'
    return
  fi
  if [[ "$OLLAMA_GPU_MODE" == cpu ]]; then
    rm -f "$GPU_COMPOSE_FILE" "$temporary_file"
    success 'Ollama permanecerá em CPU'
    return
  fi

  {
    printf 'services:\n'
    printf '  ollama:\n'
    printf '    deploy:\n'
    printf '      resources:\n'
    printf '        reservations:\n'
    printf '          devices:\n'
    printf '            - driver: nvidia\n'
    if [[ "$OLLAMA_GPU_MODE" == all ]]; then
      printf '              count: all\n'
    else
      IFS=',' read -ra device_ids <<<"$OLLAMA_GPU_DEVICE_IDS"
      (( ${#device_ids[@]} > 0 )) || fail 'Nenhuma GPU foi selecionada para o Ollama.'
      printf '              device_ids:\n'
      for device_id in "${device_ids[@]}"; do
        [[ "$device_id" =~ ^GPU-[A-Za-z0-9-]+$ ]] || fail "UUID de GPU inválido: ${device_id}"
        printf '                - "%s"\n' "$device_id"
      done
    fi
    printf '              capabilities: [gpu]\n'
    printf '    healthcheck:\n'
    printf '      test: ["CMD-SHELL", "nvidia-smi >/dev/null 2>&1 && ollama list >/dev/null 2>&1"]\n'
    printf '      interval: 30s\n'
    printf '      timeout: 10s\n'
    printf '      retries: 3\n'
    printf '      start_period: 30s\n'
  } >"$temporary_file"
  chmod 600 "$temporary_file"
  mv "$temporary_file" "$GPU_COMPOSE_FILE"
  success "Override de GPU criado em ${GPU_COMPOSE_FILE}"
}

write_ollama_quantization_compose_override() {
  local temporary_file="${OLLAMA_COMPOSE_FILE}.tmp"
  if [[ "$OLLAMA_RUNTIME" != docker ]]; then
    rm -f "$OLLAMA_COMPOSE_FILE" "$temporary_file"
    success 'Override do Ollama não é necessário para execução nativa'
    return
  fi

  {
    printf 'services:\n'
    printf '  ollama:\n'
    printf '    environment:\n'
    printf '      OLLAMA_KEEP_ALIVE: "%s"\n' "$OLLAMA_KEEP_ALIVE"
    if [[ "$OLLAMA_KEEP_ALIVE" == '-1' ]]; then
      printf '      OLLAMA_MAX_LOADED_MODELS: "2"\n'
    fi
    if [[ "$OLLAMA_KV_CACHE_QUANTIZATION" == q8_0 ]]; then
      printf '      OLLAMA_FLASH_ATTENTION: "1"\n'
      printf '      OLLAMA_KV_CACHE_TYPE: q8_0\n'
    fi
  } >"$temporary_file"
  chmod 600 "$temporary_file"
  mv "$temporary_file" "$OLLAMA_COMPOSE_FILE"
  success "Override persistente do Ollama criado em ${OLLAMA_COMPOSE_FILE}"
}

configure_google_drive_sync() {
  local sync_token_file="${DATA_DIR}/secrets/knowledge-sync/knowledge-sync-token"
  local service_account_file="${DATA_DIR}/secrets/knowledge-sync/google-drive-service-account.json"
  local legacy_token_file="${DATA_DIR}/secrets/knowledge-sync-token"
  local legacy_service_account_file="${DATA_DIR}/secrets/google-drive-service-account.json"
  if [[ ! -s "$sync_token_file" && -s "$legacy_token_file" ]]; then
    mv "$legacy_token_file" "$sync_token_file"
  fi
  if [[ ! -s "$service_account_file" && -s "$legacy_service_account_file" ]]; then
    mv "$legacy_service_account_file" "$service_account_file"
  fi
  if [[ ! -s "$sync_token_file" ]]; then
    openssl rand -hex 32 >"${sync_token_file}.tmp"
    chmod 600 "${sync_token_file}.tmp"
    mv "${sync_token_file}.tmp" "$sync_token_file"
  fi
  chmod 600 "$sync_token_file"
  [[ ! -f "$service_account_file" ]] || chmod 600 "$service_account_file"
  success 'Worker do Google Drive preparado; a integração é configurada em Bases e Drive'
}

create_proxy_credentials() {
  local openwebui_env="${DATA_DIR}/secrets/openwebui.env"
  local admin_env="${DATA_DIR}/secrets/admin.env"
  local admin_jwt_secret="${DATA_DIR}/secrets/admin-jwt-secret"
  local stored_email stored_password stored_name webui_secret
  if [[ ! -s "$openwebui_env" ]]; then
    webui_secret="$(openssl rand -hex 32)"
    write_openwebui_environment "$ADMIN_EMAIL" "$OPENWEBUI_DESIRED_PASSWORD" "$OPENWEBUI_ADMIN_NAME" "$webui_secret"
  else
    stored_email="$(sed -n 's/^WEBUI_ADMIN_EMAIL=//p' "$openwebui_env" | tail -n 1)"
    stored_password="$(sed -n 's/^WEBUI_ADMIN_PASSWORD=//p' "$openwebui_env" | tail -n 1)"
    stored_name="$(sed -n 's/^WEBUI_ADMIN_NAME=//p' "$openwebui_env" | tail -n 1)"
    webui_secret="$(sed -n 's/^WEBUI_SECRET_KEY=//p' "$openwebui_env" | tail -n 1)"
    [[ -n "$stored_email" && -n "$stored_password" && -n "$stored_name" && -n "$webui_secret" ]] \
      || fail "Configuração administrativa incompleta em ${openwebui_env}."
    write_openwebui_environment "$stored_email" "$stored_password" "$stored_name" "$webui_secret"
  fi
  local monitoring_env="${DATA_DIR}/secrets/monitoring.env"
  local monitoring_password
  if [[ ! -s "$monitoring_env" ]]; then
    monitoring_password="$(sed -n 's/^WEBUI_ADMIN_PASSWORD=//p' "$openwebui_env" | tail -n 1)"
    [[ -n "$monitoring_password" ]] || fail "Senha administrativa não encontrada para configurar o Grafana."
    {
      printf 'GF_SECURITY_ADMIN_USER=%s\n' "$ADMIN_EMAIL"
      printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$monitoring_password"
      printf 'GF_SECURITY_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"
    } >"${monitoring_env}.tmp"
    chmod 600 "${monitoring_env}.tmp"
    mv "${monitoring_env}.tmp" "$monitoring_env"
  fi
  grep -q '^GF_SECURITY_ADMIN_USER=.' "$monitoring_env" || fail "Usuário do Grafana ausente em ${monitoring_env}."
  grep -q '^GF_SECURITY_ADMIN_PASSWORD=.' "$monitoring_env" || fail "Senha do Grafana ausente em ${monitoring_env}."
  chmod 600 "$monitoring_env"

  {
    printf 'ADMIN_AUTH_USERNAME=%s\n' "$ADMIN_EMAIL"
    printf 'ADMIN_AUTH_PASSWORD=%s\n' "$OPENWEBUI_DESIRED_PASSWORD"
  } >"${admin_env}.tmp"
  chmod 600 "${admin_env}.tmp"
  mv "${admin_env}.tmp" "$admin_env"
  # Uma senha nova invalida imediatamente todas as sessões administrativas.
  if [[ ! -s "$admin_jwt_secret" || -n "$ADMIN_PASSWORD" ]]; then
    openssl rand -hex 32 >"${admin_jwt_secret}.tmp"
    chmod 600 "${admin_jwt_secret}.tmp"
    mv "${admin_jwt_secret}.tmp" "$admin_jwt_secret"
  fi
  chmod 600 "$admin_jwt_secret"
  ADMIN_PASSWORD=''

  rm -f \
    "${DATA_DIR}/secrets/proxy/.htpasswd" \
    "${DATA_DIR}/secrets/proxy/tls.crt" \
    "${DATA_DIR}/secrets/proxy/tls.key"
  success "Credenciais próprias do painel, Open WebUI e Grafana configuradas"
}

write_openwebui_environment() {
  local admin_email="$1" admin_password="$2" admin_name="$3" webui_secret="$4"
  local openwebui_env="${DATA_DIR}/secrets/openwebui.env"

  {
    if [[ -f "$openwebui_env" ]]; then
      sed -E '/^(WEBUI_ADMIN_EMAIL|WEBUI_ADMIN_PASSWORD|WEBUI_ADMIN_NAME|WEBUI_SECRET_KEY)=/d' "$openwebui_env"
    fi
    printf 'WEBUI_ADMIN_EMAIL=%s\n' "$admin_email"
    printf 'WEBUI_ADMIN_PASSWORD=%s\n' "$admin_password"
    printf 'WEBUI_ADMIN_NAME=%s\n' "$admin_name"
    printf 'WEBUI_SECRET_KEY=%s\n' "$webui_secret"
  } >"${openwebui_env}.tmp"
  chmod 600 "${openwebui_env}.tmp"
  mv "${openwebui_env}.tmp" "$openwebui_env"
}

create_environment_file() {
  local temporary_file="${ENV_FILE}.tmp" ui_port=8080 workspace_timezone=America/Maceio repository_sync_concurrency=3 existing_value compose_file compose_profiles legacy_public_url legacy_grafana_url
  local openwebui_public_url="${OPENWEBUI_PUBLIC_URL:-}" admin_public_url="${ADMIN_PUBLIC_URL:-}" grafana_public_url="${GRAFANA_PUBLIC_URL:-}" mcp_public_url="${MCP_PUBLIC_URL:-}"
  local openwebui_public_host admin_public_host grafana_public_host mcp_public_host
  if [[ -f "$ENV_FILE" ]]; then
    existing_value="$(sed -n 's/^OLLAMA_VERSION=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[A-Za-z0-9._-]+$ ]] && OLLAMA_VERSION="$existing_value"
    existing_value="$(sed -n 's/^UI_PORT=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 65535 )) && ui_port="$existing_value"
    if [[ -z "$openwebui_public_url" ]]; then
      existing_value="$(sed -n 's/^OPENWEBUI_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$existing_value" =~ ^https?://[^/[:space:]?#]+$ ]] && openwebui_public_url="$existing_value"
    fi
    if [[ -z "$openwebui_public_url" ]]; then
      legacy_public_url="$(sed -n 's/^PUBLIC_BASE_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$legacy_public_url" =~ ^https?://[^/[:space:]?#]+$ ]] && openwebui_public_url="$legacy_public_url"
    fi
    if [[ -z "$admin_public_url" ]]; then
      existing_value="$(sed -n 's/^ADMIN_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$existing_value" =~ ^https?://[^/[:space:]?#]+$ ]] && admin_public_url="$existing_value"
    fi
    if [[ -z "$grafana_public_url" ]]; then
      existing_value="$(sed -n 's/^GRAFANA_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$existing_value" =~ ^https?://[^/[:space:]?#]+$ ]] && grafana_public_url="$existing_value"
    fi
    if [[ -z "$grafana_public_url" ]]; then
      legacy_grafana_url="$(sed -n 's/^GRAFANA_ROOT_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$legacy_grafana_url" == */grafana/ ]] && grafana_public_url="${legacy_grafana_url%/grafana/}"
    fi
    if [[ -z "$mcp_public_url" ]]; then
      existing_value="$(sed -n 's/^MCP_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
      [[ "$existing_value" =~ ^https?://[^/[:space:]?#]+$ ]] && mcp_public_url="$existing_value"
    fi
    existing_value="$(sed -n 's/^WORKSPACE_TIMEZONE=//p' "$ENV_FILE" | tail -n 1)"
    [[ -n "$existing_value" ]] && workspace_timezone="$existing_value"
    existing_value="$(sed -n 's/^REPOSITORY_SYNC_CONCURRENCY=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 20 )) && repository_sync_concurrency="$existing_value"
    existing_value="$(sed -n 's/^DOCLING_VERSION=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[A-Za-z0-9._-]+$ ]] && DOCLING_VERSION="$existing_value"
    existing_value="$(sed -n 's/^DOCLING_CPU_THREADS=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 64 )) && DOCLING_CPU_THREADS="$existing_value"
    if grep -q '^RAG_RERANKING_MODEL=' "$ENV_FILE"; then
      existing_value="$(sed -n 's/^RAG_RERANKING_MODEL=//p' "$ENV_FILE" | tail -n 1)"
      [[ -z "$existing_value" || "$existing_value" =~ ^[A-Za-z0-9._\/-]+$ ]] && RAG_RERANKING_MODEL="$existing_value"
    fi
    existing_value="$(sed -n 's/^RAG_RERANKING_BATCH_SIZE=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 64 )) && RAG_RERANKING_BATCH_SIZE="$existing_value"
    existing_value="$(sed -n 's/^RAG_TOP_K=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 100 )) && RAG_TOP_K="$existing_value"
    existing_value="$(sed -n 's/^RAG_TOP_K_RERANKER=//p' "$ENV_FILE" | tail -n 1)"
    [[ "$existing_value" =~ ^[0-9]+$ ]] && (( existing_value >= 1 && existing_value <= 100 )) && RAG_TOP_K_RERANKER="$existing_value"
  fi
  compose_file="${BASE_DIR}/compose.yaml"
  [[ ! -f "$OLLAMA_COMPOSE_FILE" ]] || compose_file="${compose_file}:${OLLAMA_COMPOSE_FILE}"
  [[ ! -f "$GPU_COMPOSE_FILE" ]] || compose_file="${compose_file}:${GPU_COMPOSE_FILE}"
  compose_profiles='monitoring'
  [[ -z "$OLLAMA_COMPOSE_PROFILES" ]] || compose_profiles="${OLLAMA_COMPOSE_PROFILES},monitoring"
  openwebui_public_url="${openwebui_public_url%/}"
  admin_public_url="${admin_public_url%/}"
  grafana_public_url="${grafana_public_url%/}"
  mcp_public_url="${mcp_public_url%/}"
  [[ -n "$openwebui_public_url" ]] || openwebui_public_url="http://openwebui.localhost:${ui_port}"
  [[ -n "$admin_public_url" ]] || admin_public_url="http://admin.localhost:${ui_port}"
  [[ -n "$grafana_public_url" ]] || grafana_public_url="http://grafana.localhost:${ui_port}"
  [[ -n "$mcp_public_url" ]] || mcp_public_url="http://mcp.localhost:${ui_port}"
  openwebui_public_host="$(public_url_host "$openwebui_public_url")"
  admin_public_host="$(public_url_host "$admin_public_url")"
  grafana_public_host="$(public_url_host "$grafana_public_url")"
  mcp_public_host="$(public_url_host "$mcp_public_url")"
  printf 'CBM_CACHE_DIR=%s\nCBM_ALLOWED_ROOT=%s\nCBM_MEM_BUDGET_MB=%s\nCBM_HOST_BIN=%s\nLOCAL_UID=%s\nLOCAL_GID=%s\nUI_PORT=%s\nOPENWEBUI_PUBLIC_URL=%s\nOPENWEBUI_PUBLIC_HOST=%s\nADMIN_PUBLIC_URL=%s\nADMIN_PUBLIC_HOST=%s\nGRAFANA_PUBLIC_URL=%s\nGRAFANA_PUBLIC_HOST=%s\nMCP_PUBLIC_URL=%s\nMCP_PUBLIC_HOST=%s\nWORKSPACE_TIMEZONE=%s\nREPOSITORY_SYNC_CONCURRENCY=%s\nADMIN_EMAIL=%s\nADMIN_USERNAME=%s\nOLLAMA_VERSION=%s\nOLLAMA_CHAT_MODEL=%s\nOLLAMA_KV_CACHE_QUANTIZATION=%s\nOLLAMA_KEEP_ALIVE=%s\nOLLAMA_RUNTIME=%s\nOLLAMA_BASE_URL=%s\nCOMPOSE_FILE=%s\nCOMPOSE_PROFILES=%s\nOLLAMA_GPU_MODE=%s\nOLLAMA_GPU_DEVICE_IDS=%s\nDOCLING_VERSION=%s\nDOCLING_CPU_THREADS=%s\nRAG_RERANKING_MODEL=%s\nRAG_RERANKING_BATCH_SIZE=%s\nRAG_TOP_K=%s\nRAG_TOP_K_RERANKER=%s\n' \
    "$CACHE_DIR" "$REPOSITORIES_DIR" "$CBM_MEM_BUDGET_MB" "$CBM_CONTAINER_BIN" "$(id -u)" "$(id -g)" "$ui_port" \
    "$openwebui_public_url" "$openwebui_public_host" "$admin_public_url" "$admin_public_host" "$grafana_public_url" "$grafana_public_host" "$mcp_public_url" "$mcp_public_host" \
    "$workspace_timezone" "$repository_sync_concurrency" "$ADMIN_EMAIL" "$ADMIN_USERNAME" "$OLLAMA_VERSION" "$OLLAMA_CHAT_MODEL" "$OLLAMA_KV_CACHE_QUANTIZATION" "$OLLAMA_KEEP_ALIVE" "$OLLAMA_RUNTIME" "$OLLAMA_BASE_URL" "$compose_file" "$compose_profiles" "$OLLAMA_GPU_MODE" "$OLLAMA_GPU_DEVICE_IDS" "$DOCLING_VERSION" "$DOCLING_CPU_THREADS" "$RAG_RERANKING_MODEL" "$RAG_RERANKING_BATCH_SIZE" "$RAG_TOP_K" "$RAG_TOP_K_RERANKER" >"$temporary_file"
  chmod 600 "$temporary_file"
  mv "$temporary_file" "$ENV_FILE"
  success "Arquivo .env gerado com caminhos absolutos"
}

install_codebase_memory_command() {
  curl -fsSL "$INSTALL_URL" | CBM_DOWNLOAD_URL="$RELEASE_DOWNLOAD_URL" bash -s -- --ui --skip-config
}

install_codebase_memory() {
  if [[ -x "$CBM_BIN" ]]; then
    success "Codebase Memory MCP já está instalado"
    return
  fi
  run_step "Instalando Codebase Memory MCP" install_codebase_memory_command
  [[ -x "$CBM_BIN" ]] || fail "Executável não encontrado após a instalação: ${CBM_BIN}"
}

install_container_codebase_memory_command() {
  local docker_arch archive temporary_dir expected_checksum actual_checksum
  docker_arch="$(docker info --format '{{.Architecture}}')"
  case "$docker_arch" in
    arm64|aarch64) docker_arch='arm64' ;;
    amd64|x86_64) docker_arch='amd64' ;;
    *) fail "Arquitetura do Docker não suportada: ${docker_arch}" ;;
  esac

  archive="codebase-memory-mcp-ui-linux-${docker_arch}-portable.tar.gz"
  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/cbm-container-bin.XXXXXX")"
  curl -fsSL "${RELEASE_DOWNLOAD_URL}/${archive}" -o "${temporary_dir}/${archive}"
  curl -fsSL "${RELEASE_DOWNLOAD_URL}/checksums.txt" -o "${temporary_dir}/checksums.txt"
  expected_checksum="$(awk -v archive="$archive" '$2 == archive { print $1; exit }' "${temporary_dir}/checksums.txt")"
  [[ -n "$expected_checksum" ]] || fail "Checksum não encontrado para ${archive}."
  actual_checksum="$(shasum -a 256 "${temporary_dir}/${archive}" | awk '{ print $1 }')"
  [[ "$actual_checksum" == "$expected_checksum" ]] || fail "Checksum inválido para ${archive}."
  tar -xzf "${temporary_dir}/${archive}" -C "$temporary_dir"
  [[ -f "${temporary_dir}/codebase-memory-mcp" ]] || fail "Binário Linux não encontrado em ${archive}."
  install -m 755 "${temporary_dir}/codebase-memory-mcp" "$CBM_CONTAINER_BIN"
  rm -rf "$temporary_dir"
}

install_container_codebase_memory() {
  if [[ "$SYSTEM_PLATFORM" != macos ]]; then
    CBM_CONTAINER_BIN="$CBM_BIN"
    return
  fi
  CBM_CONTAINER_BIN="${DATA_DIR}/bin/codebase-memory-mcp"
  run_step "Instalando o binário Linux do Codebase Memory para os containers" install_container_codebase_memory_command
  [[ -x "$CBM_CONTAINER_BIN" ]] || fail "Executável dos containers não encontrado: ${CBM_CONTAINER_BIN}"
}

configure_codebase_memory_command() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  "$CBM_BIN" config set auto_index false
  "$CBM_BIN" config set auto_watch true
}

docker_compose() {
  local -a compose_files=(-f "${BASE_DIR}/compose.yaml")
  [[ ! -f "$OLLAMA_COMPOSE_FILE" ]] || compose_files+=(-f "$OLLAMA_COMPOSE_FILE")
  [[ ! -f "$GPU_COMPOSE_FILE" ]] || compose_files+=(-f "$GPU_COMPOSE_FILE")
  if [[ "$SYSTEM_PLATFORM" == macos || "$(uname -s)" == Darwin ]]; then
    docker compose "${compose_files[@]}" "$@"
    return
  fi
  if docker info >/dev/null 2>&1; then
    docker compose "${compose_files[@]}" "$@"
  else
    sudo docker compose "${compose_files[@]}" "$@"
  fi
}

start_admin_panel_command() {
  cd "$BASE_DIR"
  # O agentgateway-config altera um arquivo bind-mounted sem modificar a
  # definição do serviço. Force a recriação para o AgentGateway reler a porta
  # antes de o agentgateway-ready verificar o listener MCP.
  if ! docker_compose up -d --build --force-recreate --remove-orphans; then
    docker_compose ps -a
    if [[ "$OLLAMA_RUNTIME" == docker ]]; then
      docker_compose logs --tail=200 \
        agentgateway-config agentgateway agentgateway-ready admin proxy ollama docling open-webui openwebui-bootstrap prometheus grafana
    else
      docker_compose logs --tail=200 \
        agentgateway-config agentgateway agentgateway-ready admin proxy docling open-webui openwebui-bootstrap prometheus grafana
    fi
    return 1
  fi
  # O nginx.conf é bind-mounted. Alterá-lo não faz o Compose recriar o
  # container, portanto valide e recarregue o processo em toda instalação.
  docker_compose exec -T proxy nginx -t -c /tmp/nginx.conf
  docker_compose exec -T proxy nginx -s reload -c /tmp/nginx.conf
}

validate_admin_panel_command() {
  local attempt ui_port admin_public_host
  ui_port="$(sed -n 's/^UI_PORT=//p' "$ENV_FILE" | tail -n 1)"
  admin_public_host="$(sed -n 's/^ADMIN_PUBLIC_HOST=//p' "$ENV_FILE" | tail -n 1)"
  for attempt in {1..30}; do
    if curl -fsS "http://127.0.0.1:${ui_port}/healthz" >/dev/null \
      && curl -fsS -H "Host: ${admin_public_host}" "http://127.0.0.1:${ui_port}/login" >/dev/null \
      && docker_compose exec -T admin wget -q --spider "http://127.0.0.1:3000/api/health"; then
      return 0
    fi
    sleep 1
  done
  docker_compose logs --tail=100 admin proxy
  return 1
}

validate_agentgateway_command() {
  local attempt ui_port ready=0
  ui_port="$(sed -n 's/^UI_PORT=//p' "$ENV_FILE" | tail -n 1)"
  for attempt in {1..30}; do
    if docker_compose exec -T proxy wget -q --spider "http://agentgateway:15000/ui/" \
      && docker_compose exec -T proxy sh -c \
        'wget -qO- http://agentgateway:15000/api/config | grep -Eq "\"port\"[[:space:]]*:[[:space:]]*$1"' \
        _ "$ui_port"; then
      ready=1
      break
    fi
    sleep 1
  done
  if (( ready != 1 )); then
    docker_compose logs --tail=100 agentgateway-config agentgateway proxy
    return 1
  fi

  docker_compose exec -T admin node --input-type=module -e '
    const { readFile } = await import("node:fs/promises");
    const http = await import("node:http");
    const systemToken = (await readFile("/data/app/secrets/mcp-system-token", "utf8")).trim();
    if (!systemToken) throw new Error("Token MCP do sistema não foi criado.");
    const mcpEndpoint = "http://proxy:8080/";
    const publicHost = process.env.MCP_PUBLIC_HOST;
    if (!publicHost) throw new Error("MCP_PUBLIC_HOST não foi configurado.");
    const mcpFetch = (options = {}) => new Promise((resolve, reject) => {
      const request = http.request(mcpEndpoint, {
        method: options.method || "GET",
        headers: { ...options.headers, host: publicHost }
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const payload = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            headers: { get: name => response.headers[String(name).toLowerCase()] || null },
            text: async () => payload
          });
        });
      });
      request.setTimeout(options.timeoutMs || 10000, () => request.destroy(new Error("Timeout ao validar o endpoint MCP.")));
      request.on("error", reject);
      if (options.body) request.write(options.body);
      request.end();
    });
    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      let sessionId;
      let catalogValidated = false;
      try {
        const initializeBody = JSON.stringify({
          jsonrpc: "2.0",
          id: attempt,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "install-check", version: "1.0" }
          }
        });
        const unauthenticated = await mcpFetch({
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json"
          },
          body: initializeBody,
          timeoutMs: 5000
        });
        if (unauthenticated.status !== 401) {
          const body = await unauthenticated.text();
          throw new Error(`MCP aceitou chamada sem token: HTTP ${unauthenticated.status} ${body}`);
        }
        const response = await mcpFetch({
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${systemToken}`
          },
          body: initializeBody,
          timeoutMs: 5000
        });
        const body = await response.text();
        if (response.ok && body.includes("\"result\"")) {
          sessionId = response.headers.get("mcp-session-id");
          if (!sessionId) throw new Error("MCP initialize não retornou Mcp-Session-Id.");
          const headers = {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            authorization: `Bearer ${systemToken}`,
            "mcp-session-id": sessionId
          };
          await mcpFetch({
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/initialized",
              params: {}
            }),
            timeoutMs: 5000
          });

          const requiredTools = new Set([
            "search_graph",
            "query_graph",
            "trace_path",
            "get_code_snippet",
            "get_graph_schema",
            "get_architecture",
            "search_code",
            "list_projects",
            "index_status",
            "detect_changes"
          ]);
          const advertisedTools = new Set();
          let cursor;
          do {
            const listResponse = await mcpFetch({
              method: "POST",
              headers,
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: `tools-${cursor || "first"}`,
                method: "tools/list",
                params: cursor ? { cursor } : {}
              }),
              timeoutMs: 10000
            });
            const listBody = await listResponse.text();
            const dataLine = listBody.split("\n").find(line => line.startsWith("data:"));
            if (!listResponse.ok || !dataLine) {
              throw new Error(`tools/list falhou: HTTP ${listResponse.status} ${listBody}`);
            }
            const payload = JSON.parse(dataLine.slice(5));
            for (const tool of payload.result?.tools || []) advertisedTools.add(tool.name);
            cursor = payload.result?.nextCursor;
          } while (cursor);

          const missingTools = [...requiredTools].filter(name => !advertisedTools.has(name));
          if (missingTools.length) {
            const error = new Error(
              `Catálogo MCP incompatível; ferramentas ausentes: ${missingTools.join(", ")}. ` +
              `Ferramentas anunciadas: ${[...advertisedTools].sort().join(", ") || "nenhuma"}. ` +
              "Atualize o binário codebase-memory-mcp antes de concluir a instalação."
            );
            error.code = "MCP_CATALOG_INCOMPATIBLE";
            throw error;
          }
          catalogValidated = true;
        }
        lastError = new Error(`HTTP ${response.status} ${body}`);
      } catch (error) {
        if (error?.code === "MCP_CATALOG_INCOMPATIBLE") throw error;
        lastError = error;
      } finally {
        if (sessionId) {
          try {
            await mcpFetch({
              method: "DELETE",
              headers: {
                authorization: `Bearer ${systemToken}`,
                "mcp-session-id": sessionId
              },
              timeoutMs: 5000
            });
          } catch {
            // A validação original é mais importante que uma falha de limpeza.
          }
        }
      }
      if (catalogValidated) process.exit(0);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`MCP initialize não ficou disponível: ${lastError?.message}`);
  ' || {
    docker_compose logs --tail=200 agentgateway-config agentgateway agentgateway-ready proxy
    return 1
  }
}

validate_openwebui_command() {
  docker_compose wait openwebui-bootstrap
  docker_compose exec -T open-webui curl -fsS "http://127.0.0.1:8080/health" >/dev/null || {
    if [[ "$OLLAMA_RUNTIME" == docker ]]; then
      docker_compose logs --tail=200 ollama docling open-webui openwebui-bootstrap
    else
      docker_compose logs --tail=200 docling open-webui openwebui-bootstrap
    fi
    return 1
  }
}

validate_monitoring_command() {
  docker_compose exec -T admin node --input-type=module -e '
    const checks = await Promise.all([
      fetch("http://prometheus:9090/-/ready", { signal: AbortSignal.timeout(10000) }),
      fetch("http://grafana:3000/api/health", { signal: AbortSignal.timeout(10000) })
    ]);
    if (checks.some(response => !response.ok)) throw new Error(`monitoring=${checks.map(response => response.status).join(",")}`);
  ' || {
    docker_compose logs --tail=200 prometheus grafana
    return 1
  }
}

validate_ollama_gpu_command() {
  local visible_uuids device_id
  local -a expected_devices=()
  [[ "$OLLAMA_RUNTIME" == docker && "$OLLAMA_GPU_MODE" != cpu ]] || return 0
  visible_uuids="$(docker_compose exec -T ollama nvidia-smi --query-gpu=uuid --format=csv,noheader | sed '/^[[:space:]]*$/d' | paste -sd, - | tr -d '[:space:]')"
  [[ -n "$visible_uuids" ]] || {
    docker_compose logs --tail=200 ollama
    return 1
  }
  if [[ "$OLLAMA_GPU_MODE" == selected ]]; then
    IFS=',' read -ra expected_devices <<<"$OLLAMA_GPU_DEVICE_IDS"
    for device_id in "${expected_devices[@]}"; do
      [[ ",${visible_uuids}," == *",${device_id},"* ]] || {
        printf 'GPU selecionada não visível no container: %s\n' "$device_id" >&2
        return 1
      }
    done
  fi
  printf 'GPUs visíveis no container Ollama: %s\n' "$visible_uuids"
}

restart_and_validate_knowledge_sync_command() {
  docker_compose up -d --build --force-recreate knowledge-sync
  docker_compose exec -T admin node --input-type=module -e '
    const { readFile } = await import("node:fs/promises");
    const token = (await readFile("/data/app/secrets/knowledge-sync/knowledge-sync-token", "utf8")).trim();
    let lastError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const health = await fetch("http://knowledge-sync:3002/health", { signal: AbortSignal.timeout(3000) });
        const status = await fetch("http://knowledge-sync:3002/api/status", {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3000)
        });
        if (health.ok && status.ok) process.exit(0);
        lastError = new Error(`health=${health.status}, status=${status.status}`);
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error(`Worker não ficou disponível: ${lastError?.message}`);
  ' || {
    docker_compose logs --tail=200 knowledge-sync
    return 1
  }
}

migrate_openwebui_admin_command() {
  local openwebui_env="${DATA_DIR}/secrets/openwebui.env"
  local ui_port openwebui_public_host webui_secret auth_payload auth_response token user_id update_payload update_response

  # Em uma instalação nova, o usuário já foi criado com a credencial desejada.
  if [[ -z "$OPENWEBUI_PREVIOUS_EMAIL" || -z "$OPENWEBUI_PREVIOUS_PASSWORD" ]]; then
    ADMIN_PASSWORD=''
    OPENWEBUI_PREVIOUS_PASSWORD=''
    OPENWEBUI_DESIRED_PASSWORD=''
    return 0
  fi

  # Sem mudança de credenciais e com o nome correto, não há migração.
  if [[ "$ADMIN_EMAIL" == "$OPENWEBUI_PREVIOUS_EMAIL" \
    && "$OPENWEBUI_DESIRED_PASSWORD" == "$OPENWEBUI_PREVIOUS_PASSWORD" \
    && "$OPENWEBUI_PREVIOUS_NAME" == "$OPENWEBUI_ADMIN_NAME" ]]; then
    ADMIN_PASSWORD=''
    OPENWEBUI_PREVIOUS_PASSWORD=''
    OPENWEBUI_DESIRED_PASSWORD=''
    return 0
  fi

  ui_port="$(sed -n 's/^UI_PORT=//p' "$ENV_FILE" | tail -n 1)"
  openwebui_public_host="$(sed -n 's/^OPENWEBUI_PUBLIC_HOST=//p' "$ENV_FILE" | tail -n 1)"
  [[ -n "$openwebui_public_host" ]] || openwebui_public_host='openwebui.localhost'
  auth_payload="$(jq -cn \
    --arg email "$OPENWEBUI_PREVIOUS_EMAIL" \
    --arg password "$OPENWEBUI_PREVIOUS_PASSWORD" \
    '{email:$email,password:$password}')"
  if ! auth_response="$(printf '%s' "$auth_payload" | curl -fsS \
    --max-time 30 \
    "http://127.0.0.1:${ui_port}/api/v1/auths/signin" \
    -H "Host: ${openwebui_public_host}" \
    -H 'content-type: application/json' \
    --data-binary @-)"; then
    # Aceita também o estado em que o banco já foi alterado manualmente,
    # mas o arquivo openwebui.env ainda contém a credencial anterior.
    auth_payload="$(jq -cn \
      --arg email "$ADMIN_EMAIL" \
      --arg password "$OPENWEBUI_DESIRED_PASSWORD" \
      '{email:$email,password:$password}')"
    auth_response="$(printf '%s' "$auth_payload" | curl -fsS \
      --max-time 30 \
      "http://127.0.0.1:${ui_port}/api/v1/auths/signin" \
      -H "Host: ${openwebui_public_host}" \
      -H 'content-type: application/json' \
      --data-binary @-)"
  fi
  token="$(printf '%s' "$auth_response" | jq -er '.token')"
  user_id="$(printf '%s' "$auth_response" | jq -er '.id')"

  update_payload="$(jq -cn \
    --arg email "$ADMIN_EMAIL" \
    --arg name "$OPENWEBUI_ADMIN_NAME" \
    --arg password "$OPENWEBUI_DESIRED_PASSWORD" \
    '{email:$email,name:$name,password:$password}')"
  update_response="$(printf '%s' "$update_payload" | curl -fsS \
    --max-time 30 \
    "http://127.0.0.1:${ui_port}/api/v1/users/${user_id}/update" \
    -H "Host: ${openwebui_public_host}" \
    -H "Authorization: Bearer ${token}" \
    -H 'content-type: application/json' \
    --data-binary @-)"
  printf '%s' "$update_response" | jq -e \
    --arg email "${ADMIN_EMAIL,,}" \
    --arg name "$OPENWEBUI_ADMIN_NAME" \
    '.email == $email and .name == $name and .role == "admin"' >/dev/null

  webui_secret="$(sed -n 's/^WEBUI_SECRET_KEY=//p' "$openwebui_env" | tail -n 1)"
  [[ -n "$webui_secret" ]] || fail "WEBUI_SECRET_KEY não encontrada em ${openwebui_env}."
  write_openwebui_environment \
    "$ADMIN_EMAIL" "$OPENWEBUI_DESIRED_PASSWORD" "$OPENWEBUI_ADMIN_NAME" "$webui_secret"

  ADMIN_PASSWORD=''
  OPENWEBUI_PREVIOUS_PASSWORD=''
  OPENWEBUI_DESIRED_PASSWORD=''
}

sync_grafana_admin_command() {
  local monitoring_env="${DATA_DIR}/secrets/monitoring.env"
  local ui_port grafana_public_host stored_user stored_password auth_user auth_password
  local profile user_id theme password_payload update_payload verification

  stored_user="$(sed -n 's/^GF_SECURITY_ADMIN_USER=//p' "$monitoring_env" | tail -n 1)"
  stored_password="$(sed -n 's/^GF_SECURITY_ADMIN_PASSWORD=//p' "$monitoring_env" | tail -n 1)"
  [[ -n "$stored_user" && -n "$stored_password" ]] \
    || fail "Credencial administrativa do Grafana incompleta em ${monitoring_env}."

  ui_port="$(sed -n 's/^UI_PORT=//p' "$ENV_FILE" | tail -n 1)"
  grafana_public_host="$(sed -n 's/^GRAFANA_PUBLIC_HOST=//p' "$ENV_FILE" | tail -n 1)"
  [[ -n "$grafana_public_host" ]] || grafana_public_host='grafana.localhost'
  auth_user="$stored_user"
  auth_password="$stored_password"

  if ! profile="$(curl -fsS --max-time 30 \
    -H "Host: ${grafana_public_host}" \
    -u "${auth_user}:${auth_password}" \
    "http://127.0.0.1:${ui_port}/api/user")"; then
    # Torna a operação idempotente quando uma execução anterior atualizou o
    # banco, mas foi interrompida antes de persistir o novo arquivo de segredo.
    auth_password="$OPENWEBUI_DESIRED_PASSWORD"
    if ! profile="$(curl -fsS --max-time 30 \
      -H "Host: ${grafana_public_host}" \
      -u "${auth_user}:${auth_password}" \
      "http://127.0.0.1:${ui_port}/api/user")"; then
      auth_user="$ADMIN_EMAIL"
      auth_password="$stored_password"
      if ! profile="$(curl -fsS --max-time 30 \
        -H "Host: ${grafana_public_host}" \
        -u "${auth_user}:${auth_password}" \
        "http://127.0.0.1:${ui_port}/api/user")"; then
        auth_password="$OPENWEBUI_DESIRED_PASSWORD"
        profile="$(curl -fsS --max-time 30 \
          -H "Host: ${grafana_public_host}" \
          -u "${auth_user}:${auth_password}" \
          "http://127.0.0.1:${ui_port}/api/user")"
      fi
    fi
  fi
  user_id="$(printf '%s' "$profile" | jq -er '.id')"
  theme="$(printf '%s' "$profile" | jq -r '.theme // ""')"

  if [[ "$auth_password" != "$OPENWEBUI_DESIRED_PASSWORD" ]]; then
    password_payload="$(jq -cn --arg password "$OPENWEBUI_DESIRED_PASSWORD" '{password:$password}')"
    printf '%s' "$password_payload" | curl -fsS --max-time 30 \
      -X PUT \
      -H "Host: ${grafana_public_host}" \
      -H 'content-type: application/json' \
      -u "${auth_user}:${auth_password}" \
      "http://127.0.0.1:${ui_port}/api/admin/users/${user_id}/password" \
      --data-binary @- >/dev/null
    auth_password="$OPENWEBUI_DESIRED_PASSWORD"
  fi

  update_payload="$(jq -cn \
    --arg email "$ADMIN_EMAIL" \
    --arg name "$OPENWEBUI_ADMIN_NAME" \
    --arg login "$ADMIN_EMAIL" \
    --arg theme "$theme" \
    '{email:$email,name:$name,login:$login,theme:$theme}')"
  printf '%s' "$update_payload" | curl -fsS --max-time 30 \
    -X PUT \
    -H "Host: ${grafana_public_host}" \
    -H 'content-type: application/json' \
    -u "${auth_user}:${auth_password}" \
    "http://127.0.0.1:${ui_port}/api/users/${user_id}" \
    --data-binary @- >/dev/null

  verification="$(curl -fsS --max-time 30 \
    -H "Host: ${grafana_public_host}" \
    -u "${ADMIN_EMAIL}:${OPENWEBUI_DESIRED_PASSWORD}" \
    "http://127.0.0.1:${ui_port}/api/user")"
  printf '%s' "$verification" | jq -e \
    --arg email "${ADMIN_EMAIL,,}" \
    --arg login "${ADMIN_EMAIL,,}" \
    '.email == $email and .login == $login and .isGrafanaAdmin == true' >/dev/null

  {
    printf 'GF_SECURITY_ADMIN_USER=%s\n' "$ADMIN_EMAIL"
    printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$OPENWEBUI_DESIRED_PASSWORD"
    printf 'GF_SECURITY_ADMIN_EMAIL=%s\n' "$ADMIN_EMAIL"
  } >"${monitoring_env}.tmp"
  chmod 600 "${monitoring_env}.tmp"
  mv "${monitoring_env}.tmp" "$monitoring_env"
}

validate_installation_command() {
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  "$CBM_BIN" --version
  "$CBM_BIN" config list
  [[ -d "$CBM_CACHE_DIR" && -d "$CBM_ALLOWED_ROOT" ]]
}

show_summary() {
  local openwebui_public_url admin_public_url grafana_public_url mcp_public_url ollama_acceleration ollama_execution
  openwebui_public_url="$(sed -n 's/^OPENWEBUI_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
  admin_public_url="$(sed -n 's/^ADMIN_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
  grafana_public_url="$(sed -n 's/^GRAFANA_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
  mcp_public_url="$(sed -n 's/^MCP_PUBLIC_URL=//p' "$ENV_FILE" | tail -n 1)"
  case "$OLLAMA_GPU_MODE" in
    all) ollama_acceleration='todas as GPUs NVIDIA' ;;
    selected) ollama_acceleration="GPUs ${OLLAMA_GPU_DEVICE_IDS}" ;;
    metal) ollama_acceleration='aceleração nativa Apple (Metal)' ;;
    *) ollama_acceleration='CPU' ;;
  esac
  [[ "$OLLAMA_RUNTIME" == host ]] && ollama_execution='host macOS' || ollama_execution='Docker'
  ACTIVE_PHASE='Concluído'
  printf "\n${COLOR_GREEN}${COLOR_BOLD}✔ AMBIENTE PRONTO${COLOR_RESET}\n"
  printf "${COLOR_MUTED}Todos os serviços foram instalados e validados com sucesso.${COLOR_RESET}\n"
  print_rule
  printf "\n${COLOR_BOLD}ACESSOS${COLOR_RESET}\n"
  printf '  Open WebUI            %s/\n' "$openwebui_public_url"
  printf '  Painel administrativo %s/\n' "$admin_public_url"
  printf '  Grafana               %s/\n' "$grafana_public_url"
  printf '  Endpoint MCP          %s/\n' "$mcp_public_url"
  printf "\n${COLOR_BOLD}CONFIGURAÇÃO${COLOR_RESET}\n"
  printf '  Administrador         %s\n' "$ADMIN_EMAIL"
  printf '  Ollama                %s · cache K/V %s · residência %s · %s · %s\n' "$OLLAMA_CHAT_MODEL" "$OLLAMA_KV_CACHE_QUANTIZATION" "$OLLAMA_KEEP_ALIVE" "$ollama_execution" "$ollama_acceleration"
  printf '  Memória               %s MB\n' "$CBM_MEM_BUDGET_MB"
  printf '  Repositórios          %s\n' "$REPOSITORIES_DIR"
  printf '  Arquivo de ambiente   %s\n' "$ENV_FILE"
  printf "\n${COLOR_BOLD}PRÓXIMOS PASSOS${COLOR_RESET}\n"
  printf '  1. Entre no painel administrativo com %s.\n' "$ADMIN_EMAIL"
  printf '  2. Conecte seu token do GitHub e adicione os repositórios.\n'
  printf '  3. Configure o Google Drive em Bases e Drive, se necessário.\n'
}

main() {
  show_welcome
  require_supported_system
  success "Sistema compatível detectado: ${SYSTEM_PLATFORM} (${SYSTEM_ARCHITECTURE})"
  info 'Pressione Enter para aceitar o valor padrão exibido em cada etapa.'
  ask_memory_budget
  ask_ollama_runtime
  ask_ollama_model
  ask_ollama_quantization
  ask_ollama_keep_alive
  ask_ollama_gpu
  ask_proxy_access
  ask_public_urls

  if ! confirm_configuration; then
    printf "\n${COLOR_YELLOW}Instalação cancelada.${COLOR_RESET} Nenhuma alteração foi aplicada.\n\n"
    return 0
  fi

  show_install_phase 1 'Sistema e dependências' 'Validando permissões e preparando Docker e ferramentas do host.'
  validate_sudo
  keep_sudo_alive
  install_dependencies
  install_host_ollama
  if [[ "$OLLAMA_RUNTIME" == docker && "$OLLAMA_GPU_MODE" != cpu ]]; then
    run_step "Configurando o runtime NVIDIA no Docker" configure_nvidia_runtime_command
  fi

  show_install_phase 2 'Configuração local' 'Preparando diretórios, segredos, binários e variáveis do ambiente.'
  create_local_structure
  write_ollama_quantization_compose_override
  write_ollama_gpu_compose_override
  configure_google_drive_sync
  create_proxy_credentials
  install_codebase_memory
  install_container_codebase_memory
  create_environment_file
  run_step "Aplicando configurações do Codebase Memory" configure_codebase_memory_command
  run_step "Validando a instalação" validate_installation_command

  show_install_phase 3 'Serviços' 'Construindo containers e iniciando os componentes da plataforma.'
  run_step "Construindo e iniciando o painel administrativo" start_admin_panel_command
  if [[ "$OLLAMA_RUNTIME" == docker && "$OLLAMA_GPU_MODE" != cpu ]]; then
    run_step "Validando o acesso do Ollama às GPUs" validate_ollama_gpu_command
  fi
  run_step "Aguardando o painel ficar disponível" validate_admin_panel_command

  show_install_phase 4 'Verificações finais' 'Testando integrações, modelos, monitoramento e workers.'
  run_step "Validando o AgentGateway e o endpoint MCP" validate_agentgateway_command
  run_step "Baixando modelos e configurando o Open WebUI" validate_openwebui_command
  run_step "Validando Prometheus e Grafana" validate_monitoring_command
  run_step "Sincronizando a credencial administrativa do Grafana" sync_grafana_admin_command
  run_step "Sincronizando a credencial administrativa do Open WebUI" migrate_openwebui_admin_command
  run_step "Preparando o worker do Google Drive" restart_and_validate_knowledge_sync_command
  show_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
