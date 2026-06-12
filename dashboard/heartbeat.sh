#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.json"
LOCK_DIR="${SCRIPT_DIR}/.heartbeat_locks"
LOG_FILE="${SCRIPT_DIR}/heartbeat.log"
SCRIPT_LOCK="${SCRIPT_DIR}/.heartbeat.run.lock"

read_config_number() {
  local key="$1"
  local default_val="$2"
  node -e "const c=require('${CONFIG_FILE}');const v=(c.heartbeat||{})['${key}'];process.stdout.write(String(Number.isFinite(v)?v:${default_val}));" 2>/dev/null || printf '%s' "$default_val"
}

LOCK_TTL_SEC="$(read_config_number lockTtlSec 14400)"
SCRIPT_LOCK_STALE_SEC="$(read_config_number scriptLockStaleSec 1800)"

usage() {
  cat <<EOF
Usage:
  bash heartbeat.sh                未着手タスクを表示（人手起動向け）
  bash heartbeat.sh --copy <agent> 起動コマンドをクリップボードへコピー
  bash heartbeat.sh --auto         未着手タスクの担当エージェントを自動起動
  bash heartbeat.sh --auto --yes   --auto の確認プロンプトをスキップ

環境変数:
  HEARTBEAT_WHITELIST=jet,nameo    --auto で対象を絞り込む

ロック（config.json の heartbeat.* で変更可）:
  .heartbeat_locks/<agent>.lock    同一エージェントの再起動を ${LOCK_TTL_SEC} 秒抑制 (lockTtlSec)
  .heartbeat_locks/<agent>.pid     --auto で起動した子プロセスのPID（存活判定に使用）
  .heartbeat.run.lock              本スクリプト自体の多重実行を防止
EOF
}

log() {
  local msg="$1"
  local ts
  ts="$(date -Iseconds)"
  printf '[%s] %s\n' "$ts" "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

copy_to_clipboard() {
  local text="$1"
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$text" | wl-copy; return 0; fi
  if command -v xclip >/dev/null 2>&1; then printf '%s' "$text" | xclip -selection clipboard; return 0; fi
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$text" | pbcopy; return 0; fi
  if command -v clip.exe >/dev/null 2>&1; then printf '%s' "$text" | clip.exe; return 0; fi
  return 1
}

acquire_script_lock() {
  exec 9>"$SCRIPT_LOCK"
  if ! flock -n 9; then
    echo "別の heartbeat 実行が進行中です。終了します。" >&2
    log "skipped: script lock busy"
    exit 0
  fi
}

is_lock_fresh() {
  local lock_path="$1"
  [[ -f "$lock_path" ]] || return 1
  local now mtime age
  now="$(date +%s)"
  mtime="$(stat -c %Y "$lock_path" 2>/dev/null || stat -f %m "$lock_path" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  [[ $age -lt $LOCK_TTL_SEC ]]
}

# プロセスのコマンドラインを取得（/proc 非依存・macOS/Linux 両対応）
pid_cmdline() {
  ps -o command= -p "$1" 2>/dev/null || ps -o args= -p "$1" 2>/dev/null || true
}

# プロセスの cwd を取得。Linux は /proc、macOS は lsof で引く
pid_cwd() {
  local pid="$1"
  if [[ -e "/proc/${pid}/cwd" ]]; then
    readlink "/proc/${pid}/cwd" 2>/dev/null || true
  else
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1
  fi
}

pid_or_descendant_is_claude() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null || return 1
  local cmdline
  cmdline="$(pid_cmdline "$pid")"
  if [[ "$cmdline" == *claude* ]]; then
    return 0
  fi
  local children child
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    if pid_or_descendant_is_claude "$child"; then
      return 0
    fi
  done
  return 1
}

is_agent_running() {
  local workspace="$1"
  local agent="$2"
  [[ -n "$workspace" ]] || return 1

  local pid_file="${LOCK_DIR}/${agent}.pid"
  if [[ -f "$pid_file" ]]; then
    local recorded_pid
    recorded_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ "$recorded_pid" =~ ^[0-9]+$ ]] && pid_or_descendant_is_claude "$recorded_pid"; then
      return 0
    fi
    rm -f "$pid_file" 2>/dev/null || true
  fi

  local workspace_real
  # readlink -f は macOS の旧 readlink に無いため cd && pwd -P で実体パス化
  workspace_real="$(cd "$workspace" 2>/dev/null && pwd -P || printf '%s' "$workspace")"
  [[ -n "$workspace_real" ]] || return 1

  # claude を含むプロセスを列挙し、cwd が workspace のものを探す（/proc 全走査の代替）
  local pid cwd
  for pid in $(pgrep -f claude 2>/dev/null || true); do
    cwd="$(pid_cwd "$pid")"
    [[ "$cwd" == "$workspace_real" ]] || continue
    return 0
  done
  return 1
}

extract_workspace() {
  local cmd="$1"
  local extracted
  extracted="$(printf '%s' "$cmd" | sed -n 's/.*cd \([^ ]\+\).*/\1/p' | head -n1)"
  printf '%s' "$extracted"
}

MODE="list"
COPY_AGENT=""
AUTO_YES="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    "")
      shift ;;
    --copy)
      MODE="copy"
      COPY_AGENT="${2:-}"
      if [[ -z "$COPY_AGENT" ]]; then
        echo "エラー: --copy にはエージェント名が必要です。" >&2
        usage
        exit 1
      fi
      shift 2 ;;
    --auto)
      MODE="auto"
      shift ;;
    --yes)
      AUTO_YES="true"
      shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      echo "エラー: 不明な引数です: $1" >&2
      usage
      exit 1 ;;
  esac
done

acquire_script_lock
mkdir -p "$LOCK_DIR"

RESULT_JSON="$(
node - "$CONFIG_FILE" "$MODE" "$COPY_AGENT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , configPath, mode, copyAgent] = process.argv;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const baseDir = path.dirname(configPath);
const taskDir = path.resolve(baseDir, config.taskDir || '../tasks');
const commands = config.serverOnly?.startCommands || {};
const agents = config.agents || {};

function parseScalar(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '[]') return [];
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(value) {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((item) => parseScalar(item));
}

function parseFrontMatter(markdown) {
  const match = String(markdown).match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { data: {}, error: 'front_matter_not_found' };

  const data = {};
  const lines = match[1].split(/\r?\n/);
  let currentArrayKey = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue;

    if (/^\s*-\s+/.test(line) && currentArrayKey) {
      data[currentArrayKey].push(parseScalar(line.replace(/^\s*-\s+/, '')));
      continue;
    }

    currentArrayKey = null;
    const keyValue = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValue) continue;

    const [, key, rawValue] = keyValue;
    if (!rawValue) {
      data[key] = [];
      currentArrayKey = key;
      continue;
    }

    if (rawValue.trim().startsWith('[') && rawValue.trim().endsWith(']')) {
      data[key] = parseInlineArray(rawValue.trim());
      continue;
    }

    data[key] = parseScalar(rawValue);
  }

  return { data, error: null };
}

function getAssignee(task) {
  return String(task.assigned_to ?? task.assignee ?? '').trim();
}

function isHeartbeatTarget(task) {
  const status = String(task.status || '').trim();
  const assignee = getAssignee(task);
  const blockedBy = Array.isArray(task.blocked_by) ? task.blocked_by : [];
  return status === 'pending' && assignee && blockedBy.length === 0;
}

const result = {
  generatedAt: new Date().toISOString(),
  mode,
  copyAgent,
  tasks: [],
  grouped: {},
  commands: {},
  warnings: []
};

let files = [];
try {
  files = fs.readdirSync(taskDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ja'));
} catch (error) {
  result.warnings.push(`taskDir を読み取れません: ${error.message}`);
}

for (const fileName of files) {
  try {
    const fullPath = path.join(taskDir, fileName);
    const content = fs.readFileSync(fullPath, 'utf8');
    const parsed = parseFrontMatter(content);
    if (parsed.error) {
      result.warnings.push(`${fileName}: ${parsed.error}`);
      continue;
    }

    const task = parsed.data;
    if (!isHeartbeatTarget(task)) continue;

    const assignee = getAssignee(task);
    const item = {
      file: fileName,
      id: task.id ?? null,
      title: task.title || '(無題タスク)',
      priority: task.priority || 'unknown',
      assignee,
      updated: task.updated || null,
      command: commands[assignee] || ''
    };

    result.tasks.push(item);
    if (!result.grouped[assignee]) result.grouped[assignee] = [];
    result.grouped[assignee].push(item);
    if (commands[assignee]) result.commands[assignee] = commands[assignee];
  } catch (error) {
    result.warnings.push(`${fileName}: ${error.message}`);
  }
}

if (mode === 'copy') {
  if (!copyAgent || !commands[copyAgent]) {
    result.copyError = 'copy_target_not_found';
  } else {
    result.copyCommand = commands[copyAgent];
    result.copyAgentLabel = agents[copyAgent]?.label || copyAgent;
  }
}

console.log(JSON.stringify(result));
NODE
)"

extract_field() {
  local key="$1"
  printf '%s' "$RESULT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);process.stdout.write(String(o['${key}']||''));});"
}

list_assignees() {
  printf '%s' "$RESULT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);process.stdout.write(Object.keys(o.commands||{}).join('\n'));});"
}

get_command_for() {
  local agent="$1"
  printf '%s' "$RESULT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);process.stdout.write(String((o.commands||{})['${agent}']||''));});"
}

if [[ "$MODE" == "copy" ]]; then
  COPY_COMMAND="$(extract_field copyCommand)"
  COPY_LABEL="$(extract_field copyAgentLabel)"
  COPY_ERROR="$(extract_field copyError)"

  if [[ -n "$COPY_ERROR" || -z "$COPY_COMMAND" ]]; then
    echo "エラー: 指定エージェントのコピー対象コマンドが見つかりません。" >&2
    log "copy failed: agent=${COPY_AGENT}"
    exit 1
  fi

  if copy_to_clipboard "$COPY_COMMAND"; then
    echo "${COPY_LABEL:-$COPY_AGENT} の起動コマンドをクリップボードへコピーしました。"
    log "copied: agent=${COPY_AGENT}"
  else
    echo "クリップボード操作に対応したコマンドが見つかりませんでした。以下を手動でコピーしてください。"
    echo
    printf '%s\n' "$COPY_COMMAND"
    log "copy fallback printed: agent=${COPY_AGENT}"
  fi
  exit 0
fi

if [[ "$MODE" == "auto" ]]; then
  IFS=',' read -r -a WHITELIST <<< "${HEARTBEAT_WHITELIST:-}"
  declare -A IN_WHITELIST=()
  for w in "${WHITELIST[@]}"; do
    [[ -n "$w" ]] && IN_WHITELIST["$w"]=1
  done

  ASSIGNEES="$(list_assignees || true)"
  if [[ -z "$ASSIGNEES" ]]; then
    echo "未着手の起動候補はありません。"
    log "auto: no targets"
    exit 0
  fi

  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    if [[ ${#IN_WHITELIST[@]} -gt 0 && -z "${IN_WHITELIST[$agent]:-}" ]]; then
      echo "[skip] ${agent}: ホワイトリスト対象外"
      continue
    fi

    LOCK_PATH="${LOCK_DIR}/${agent}.lock"
    if is_lock_fresh "$LOCK_PATH"; then
      echo "[skip] ${agent}: ロック有効期間内（${LOCK_TTL_SEC}秒）"
      log "auto skip lock: ${agent}"
      continue
    fi

    CMD="$(get_command_for "$agent")"
    if [[ -z "$CMD" ]]; then
      echo "[skip] ${agent}: 起動コマンド未設定"
      continue
    fi

    WORKSPACE="$(extract_workspace "$CMD")"
    if is_agent_running "$WORKSPACE" "$agent"; then
      echo "[skip] ${agent}: 既に起動中（${WORKSPACE}）"
      log "auto skip running: ${agent}"
      date +%s > "$LOCK_PATH"
      continue
    fi

    if [[ "$AUTO_YES" != "true" ]]; then
      printf '起動しますか？ [%s] (y/N): ' "$agent"
      read -r answer
      if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
        echo "[cancel] ${agent}"
        continue
      fi
    fi

    echo "[launch] ${agent}: 起動コマンドを実行します"
    log "auto launch: ${agent}"
    date +%s > "$LOCK_PATH"
    bash -c "$CMD" >/dev/null 2>&1 &
    LAUNCH_PID=$!
    printf '%s' "$LAUNCH_PID" > "${LOCK_DIR}/${agent}.pid"
    disown "$LAUNCH_PID" 2>/dev/null || disown || true
  done <<< "$ASSIGNEES"

  exit 0
fi

RENDER_SCRIPT="$(mktemp)"
trap 'rm -f "$RENDER_SCRIPT"' EXIT

cat > "$RENDER_SCRIPT" <<'NODE'
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const obj = JSON.parse(input);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  console.log(`Heartbeat check: ${formatter.format(new Date(obj.generatedAt))} JST`);
  console.log('');

  if (obj.warnings && obj.warnings.length) {
    console.log('Warnings:');
    for (const w of obj.warnings) console.log(`- ${w}`);
    console.log('');
  }

  if (!obj.tasks || obj.tasks.length === 0) {
    console.log('未着手かつ起動候補のタスクはありません。');
    return;
  }

  console.log(`未着手タスク: ${obj.tasks.length}件`);
  console.log('');

  for (const [assignee, items] of Object.entries(obj.grouped || {})) {
    console.log(`[${assignee}] ${items.length}件`);
    for (const item of items) {
      const priority = item.priority || 'unknown';
      const updated = item.updated || '-';
      console.log(`  - #${item.id ?? '-'} ${item.title} (priority: ${priority}, updated: ${updated})`);
    }

    if (obj.commands && obj.commands[assignee]) {
      console.log('  コピー用コマンド:');
      console.log(`    ${obj.commands[assignee]}`);
      console.log(`  コピーする場合: bash heartbeat.sh --copy ${assignee}`);
    } else {
      console.log('  起動コマンド未設定');
    }

    console.log('');
  }
});
NODE

printf '%s' "$RESULT_JSON" | node "$RENDER_SCRIPT"

TASK_COUNT="$(printf '%s' "$RESULT_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const o=JSON.parse(d);process.stdout.write(String((o.tasks||[]).length));});")"
log "list ok: tasks=${TASK_COUNT}"
