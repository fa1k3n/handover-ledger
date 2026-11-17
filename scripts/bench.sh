#!/bin/bash
# The figures of `howl`, taken on fixed inputs (#160): the time and the memory of each command, so that a change can
# show what it moved. The figures are shown, never enforced.
#
#   scripts/bench.sh                       every case on ledgers of 100, 10,000 and 100,000 lines
#   scripts/bench.sh --json                the same as JSON
#   scripts/bench.sh --runs 9              repetitions after one warm-up (default 7)
#   scripts/bench.sh --sizes 100,10000     the ledgers to make (default 100,10000,100000)
#   scripts/bench.sh --seed 7              the seed of the inputs (default 1)
#   scripts/bench.sh --anyway              run although the processor's clock is low
#   scripts/bench.sh --demo FOLDER         also the demo's flow, played in a copy of FOLDER
#   scripts/bench.sh --keep FOLDER         with --demo: keep `howl show` and `howl status --json` after each step
#   scripts/bench.sh --only seeded|demo    leave the other part out
#   scripts/bench.sh --make FOLDER         only make the inputs in FOLDER, and end
#   scripts/bench.sh --compare A B         compare two --keep folders, with times and ids masked; 1 when they differ
#
#   HOWL_BIN   the command to run as `howl` (default: node src/cli/howl.ts of this checkout)
#
# Everything runs in a scratch folder with a HOWL_HOME of its own: never a real ledger. Time is taken with the shell
# around each run, memory with /usr/bin/time (the peak resident set, in KB). The median and the 90th percentile (the
# nearest rank) are of the runs after the warm-up. Making the inputs needs Node, with any HOWL_BIN.
# @code_class rules
set -u -o pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOWL_BIN=${HOWL_BIN:-node $ROOT/src/cli/howl.ts}
RUNS=7
SIZES=100,10000,100000
SEED=1
JSON=0
ANYWAY=0
DEMO=
KEEP=
ONLY=
MAKE=
COMPARE=()

die() { echo "bench: $*" >&2; exit 2; }
usage() { sed -n '2,/^# @code_class/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case $1 in
    --json) JSON=1 ;;
    --anyway) ANYWAY=1 ;;
    --runs) [ $# -ge 2 ] || die "--runs needs a number"; RUNS=$2; shift ;;
    --sizes) [ $# -ge 2 ] || die "--sizes needs a list"; SIZES=$2; shift ;;
    --seed) [ $# -ge 2 ] || die "--seed needs a number"; SEED=$2; shift ;;
    --demo) [ $# -ge 2 ] || die "--demo needs a folder"; DEMO=$2; shift ;;
    --keep) [ $# -ge 2 ] || die "--keep needs a folder"; KEEP=$2; shift ;;
    --only) [ $# -ge 2 ] || die "--only needs seeded or demo"; ONLY=$2; shift ;;
    --make) [ $# -ge 2 ] || die "--make needs a folder"; MAKE=$2; shift ;;
    --compare) [ $# -ge 3 ] || die "--compare needs two folders"; COMPARE=("$2" "$3"); shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) die "no such option: $1 (try --help)" ;;
  esac
  shift
done

case $RUNS in '' | *[!0-9]* | 0) die "--runs needs a number above 0" ;; esac
case $SEED in '' | *[!0-9]*) die "--seed needs a number" ;; esac
case $ONLY in '' | seeded | demo) ;; *) die "--only is seeded or demo" ;; esac
case $SIZES in '' | *[!0-9,]* | *,,* | ,* | *,) die "--sizes is a list of numbers, as 100,10000" ;; esac
IFS=, read -r -a SIZE_LIST <<< "$SIZES"
for s in "${SIZE_LIST[@]}"; do [ "$s" -ge 2 ] || die "a ledger has at least 2 lines"; done

# Comparing two sets of kept outputs -----------------------------------------------------------------------------

# What differs from one run to the next for no reason of the version: times, spans, ids, sessions, pseudonyms.
mask() {
  sed -E \
    -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?(\.[0-9]+)?Z?/<time>/g' \
    -e 's/[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?/<time>/g' \
    -e 's/[0-9]+ ?(d|h|min|m|s|ms)([^A-Za-z0-9]|$)/<span>\2/g' \
    -e 's/demo-agent-[0-9]+/<session>/g' \
    -e 's#/[^ ]*howl-bench\.[A-Za-z0-9]+#<scratch>#g' \
    -e 's/person-[0-9a-f]{8}/<person>/g' \
    -e 's/\b[0-9a-f]{7,64}\b/<id>/g' "$1"
}

if [ ${#COMPARE[@]} -gt 0 ]; then
  a=${COMPARE[0]}
  b=${COMPARE[1]}
  [ -d "$a" ] && [ -d "$b" ] || die "--compare needs two folders"
  different=0
  for f in "$a"/* "$b"/*; do
    name=$(basename "$f")
    if [ ! -e "$a/$name" ] || [ ! -e "$b/$name" ]; then
      echo "only in one: $name"
      different=1
    fi
  done
  for f in "$a"/*; do
    name=$(basename "$f")
    [ -e "$b/$name" ] || continue
    if ! diff <(mask "$f") <(mask "$b/$name") > /dev/null; then
      echo "differs: $name"
      diff <(mask "$f") <(mask "$b/$name") | sed 's/^/  /' | head -n 20
      different=1
    fi
  done
  if [ $different -eq 0 ]; then echo "the same, with times and ids masked"; fi
  exit $different
fi

# The processor's clock ------------------------------------------------------------------------------------------

# The highest clock of any core, in MHz. A core at rest runs slowly: only a clock that stays low is a fault.
clock_mhz() { awk -F: '/^cpu MHz/ { if ($2 + 0 > m) m = $2 + 0 } END { printf "%d", m }' "${BENCH_CPUINFO:-/proc/cpuinfo}"; }
max_mhz() {
  local file=${BENCH_MAX_FREQ:-/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq} khz
  [ -r "$file" ] || return 1
  read -r khz < "$file" || return 1
  echo $((khz / 1000))
}
now_ns() { date +%s%N; }
# A short burst of work, so that a clock that is only resting has risen when it is read.
warm_up_clock() {
  [ -z "${BENCH_CPUINFO:-}" ] || return 0
  local end=$(($(now_ns) + 300000000))
  while [ "$(now_ns)" -lt "$end" ]; do :; done
}

CLOCK_START=0
CLOCK_MAX=0
if [ -z "$MAKE" ]; then
  warm_up_clock
  CLOCK_START=$(clock_mhz)
  CLOCK_MAX=$(max_mhz) || CLOCK_MAX=0
  if [ "$CLOCK_MAX" -gt 0 ] && [ $((CLOCK_START * 2)) -lt "$CLOCK_MAX" ] && [ $ANYWAY -eq 0 ]; then
    echo "bench: the processor runs at $CLOCK_START MHz, below half of its $CLOCK_MAX MHz: the times would say nothing about howl." >&2
    echo "bench: look at the governor and the temperature, or run again with --anyway." >&2
    exit 1
  fi
fi

command -v node > /dev/null || die "making the inputs needs node"
[ -x /usr/bin/time ] || die "the memory is taken with /usr/bin/time (GNU time): it is not installed"

# The inputs -------------------------------------------------------------------------------------------------------

if [ -n "$MAKE" ]; then
  mkdir -p "$MAKE" && node "$ROOT/scripts/bench-seed.ts" "$MAKE" --seed "$SEED" --sizes "$SIZES" || die "the inputs could not be made"
  exit 0
fi

W=$(mktemp -d "${TMPDIR:-/tmp}/howl-bench.XXXXXX") || die "no scratch folder"
SERVE_PID=
cleanup() {
  [ -z "$SERVE_PID" ] || pkill -TERM -P "$SERVE_PID" 2> /dev/null
  rm -rf "$W"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$W/home" "$W/in"
IN=$W/in
REPO=$IN/repo

[ "$ONLY" = demo ] || echo "bench: making the inputs (seed $SEED, sizes $SIZES)" >&2
[ "$ONLY" = demo ] || node "$ROOT/scripts/bench-seed.ts" "$IN" --seed "$SEED" --sizes "$SIZES" || die "the inputs could not be made"

# The results ---------------------------------------------------------------------------------------------------------

R_KEY=(); R_LINES=(); R_MED=(); R_P90=(); R_MEM=(); R_NOTE=(); R_GROUP=()
I_NAME=(); I_BYTES=()

jesc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "$s"; }
ms() { printf '%d.%d' $(($1 / 1000)) $((($1 % 1000) / 100)); }  # microseconds as milliseconds, one decimal

# Records one case: group, key, lines (or empty), the times in microseconds, the peak memory in KB, a note (or empty).
record() {
  local group=$1 key=$2 lines=$3 mem=$4 note=$5; shift 5
  local med=- p90=-
  if [ $# -gt 0 ]; then
    local sorted n
    mapfile -t sorted < <(printf '%s\n' "$@" | sort -n)
    n=${#sorted[@]}
    if [ $((n % 2)) -eq 1 ]; then med=${sorted[$((n / 2))]}; else med=$(((sorted[n / 2 - 1] + sorted[n / 2]) / 2)); fi
    p90=${sorted[$(((n * 9 + 9) / 10 - 1))]}
  fi
  R_GROUP+=("$group"); R_KEY+=("$key"); R_LINES+=("$lines"); R_MED+=("$med"); R_P90+=("$p90"); R_MEM+=("$mem"); R_NOTE+=("$note")
  if [ $JSON -eq 0 ]; then
    local where=
    [ -z "$lines" ] || where="$lines lines"
    if [ -n "$note" ]; then
      printf '%-44s %-12s skipped: %s\n' "$key" "$where" "$note"
    else
      printf '%-44s %-12s median %10s ms  p90 %10s ms  peak %8s KB\n' "$key" "$where" "$(ms "$med")" "$(ms "$p90")" "$mem"
    fi
  else
    echo "bench: $key${lines:+ ($lines lines)}${note:+ skipped: $note}" >&2
  fi
}

# Runs the command of the case once with a clean environment: the time in microseconds goes to $US, the peak memory to
# $MEM, the status to $STATUS. The warm-up and the runs use it alike.
EXTRA=()
STATUS=0; US=0; MEM=0
run_once() { # home stdin args...
  local home=$1 stdin=$2; shift 2
  local t0 t1
  t0=$(now_ns)
  (cd "$REPO" && env -i PATH="$PATH" HOME="$W/home" TZ=UTC HOWL_HOME="$home" "${EXTRA[@]}" /usr/bin/time -f %M -o "$W/mem" $HOWL_BIN "$@" < "$stdin" > "$W/out" 2> "$W/err")
  STATUS=$?
  t1=$(now_ns)
  US=$(((t1 - t0) / 1000))
  MEM=$(tail -n 1 "$W/mem" 2> /dev/null)
  case $MEM in '' | *[!0-9]*) MEM=0 ;; esac
}

# One case: after one warm-up, RUNS runs, each after `prepare` (not timed).
measure() { # group key lines home prepare stdin args...
  local group=$1 key=$2 lines=$3 home=$4 prepare=$5 stdin=$6; shift 6
  local times=() peak=0 i
  for ((i = 0; i <= RUNS; i++)); do
    [ -z "$prepare" ] || "$prepare"
    run_once "$home" "$stdin" "$@"
    if [ $STATUS -ne 0 ]; then
      record "$group" "$key" "$lines" 0 "exit $STATUS: $(head -n 1 "$W/err" | cut -c1-120)"
      EXTRA=()
      return 0
    fi
    [ $i -eq 0 ] && continue
    times+=("$US")
    [ "$MEM" -le "$peak" ] || peak=$MEM
  done
  record "$group" "$key" "$lines" "$peak" "" "${times[@]}"
  EXTRA=()
}

# The sizes a case on "the" ledger takes: 10,000 lines and 100,000, else the largest that was made.
has_size() { local s; for s in "${SIZE_LIST[@]}"; do [ "$s" = "$1" ] && return 0; done; return 1; }
largest() { local m=0 s; for s in "${SIZE_LIST[@]}"; do [ "$s" -le "$m" ] || m=$s; done; echo "$m"; }
smallest() { local m=999999999 s; for s in "${SIZE_LIST[@]}"; do [ "$s" -ge "$m" ] || m=$s; done; echo "$m"; }
size_for() { if has_size "$1"; then echo "$1"; else largest; fi; }
home_of() { echo "$IN/home-$1"; }
manifest() { # size field
  node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(m.shown[process.argv[2]][process.argv[3]]);' "$IN/manifest.json" "$1" "$2"
}

EMPTY=$W/empty
: > "$EMPTY"

# The seeded cases ----------------------------------------------------------------------------------------------------

prepare_hook() { rm -rf "$W/run-hook/bench/inbox"; }
prepare_ingest() { rm -rf "$W/run-ingest"; mkdir -p "$W/run-ingest" && cp -a "$IN/ingest-base/bench" "$W/run-ingest/bench"; }
prepare_observe() { rm -rf "$W/run-observe"; }

seeded() {
  local small reader filter size change
  small=$(smallest)
  reader=$(size_for 10000)
  filter=$(size_for 100000)

  measure start "howl help" "" "$(home_of "$small")" "" "$EMPTY" help

  printf '{"session_id":"s-bench","cwd":"%s","hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{"file_path":"%s/src/a.rs"},"tool_response":{}}' "$REPO" "$REPO" > "$W/hook.json"
  EXTRA=(HOWL_ACTOR=agent-1 HOWL_TASK=1); measure hook "howl hook (empty input)" "" "$W/run-hook" prepare_hook "$EMPTY" hook
  EXTRA=(HOWL_ACTOR=agent-1 HOWL_TASK=1); measure hook "howl hook (PostToolUse)" "" "$W/run-hook" prepare_hook "$W/hook.json" hook

  for size in "${SIZE_LIST[@]}"; do
    measure verify "howl verify" "$size" "$(home_of "$size")" "" "$EMPTY" verify --project bench
  done

  change=$(manifest "$reader" change)
  measure read "howl show <change>" "$reader" "$(home_of "$reader")" "" "$EMPTY" show "$change"
  measure read "howl show <change> --json" "$reader" "$(home_of "$reader")" "" "$EMPTY" show "$change" --json
  for size in "${SIZE_LIST[@]}"; do
    measure fold "howl status --json" "$size" "$(home_of "$size")" "" "$EMPTY" status --json
  done
  measure filter "howl watch --no-follow --filter '...'" "$filter" "$(home_of "$filter")" "" "$EMPTY" \
    watch --no-follow --filter 'event.type.startsWith("review.") && event.source.kind == "observed"'

  measure writer "howl ingest (1000 inbox files)" "" "$W/run-ingest" prepare_ingest "$EMPTY" ingest
  measure writer "howl observe --once (first round)" "" "$W/run-observe" prepare_observe "$EMPTY" observe --once
  # After its warm-up, the home holds what the host shows: a round that finds nothing new.
  rm -rf "$W/run-observe"
  measure writer "howl observe --once (nothing new)" "" "$W/run-observe" "" "$EMPTY" observe --once

  measure export "howl export --change <change>" "$reader" "$(home_of "$reader")" "" "$EMPTY" export --change "$change" --out "$W/bundle.tar.gz"

  serve "$reader"
  installed
}

# `howl serve` on a port of its own, and the time to the first 200 of /api/overview.
serve() { # size
  local size=$1 times=() peak=0 i note= t0 t1 url n
  for ((i = 0; i <= RUNS; i++)); do
    : > "$W/serve.out"; : > "$W/serve.err"; rm -f "$W/mem"
    t0=$(now_ns)
    (cd "$REPO" && exec env -i PATH="$PATH" HOME="$W/home" TZ=UTC HOWL_HOME="$(home_of "$size")" /usr/bin/time -f %M -o "$W/mem" $HOWL_BIN serve --port 0 > "$W/serve.out" 2> "$W/serve.err") &
    SERVE_PID=$!
    url=
    for ((n = 0; n < 6000; n++)); do
      url=$(grep -o -m1 'http://127\.0\.0\.1:[0-9]*' "$W/serve.out")
      [ -z "$url" ] || break
      kill -0 "$SERVE_PID" 2> /dev/null || break
      sleep 0.005
    done
    if [ -n "$url" ]; then
      until curl -sf -o /dev/null "$url/api/overview"; do
        n=$((n + 1))
        kill -0 "$SERVE_PID" 2> /dev/null && [ $n -lt 6000 ] || { url=; break; }
        sleep 0.005
      done
    fi
    t1=$(now_ns)
    pkill -TERM -P "$SERVE_PID" 2> /dev/null
    wait "$SERVE_PID" 2> /dev/null
    SERVE_PID=
    if [ -z "$url" ]; then note="no answer: $(head -n 1 "$W/serve.err" | cut -c1-120)"; break; fi
    MEM=$(tail -n 1 "$W/mem" 2> /dev/null)
    case $MEM in '' | *[!0-9]*) MEM=0 ;; esac
    [ $i -eq 0 ] && continue
    times+=($(((t1 - t0) / 1000)))
    [ "$MEM" -le "$peak" ] || peak=$MEM
  done
  if [ -n "$note" ]; then
    record serve "howl serve: first /api/overview" "$size" 0 "$note"
  else
    record serve "howl serve: first /api/overview" "$size" "$peak" "" "${times[@]}"
  fi
}

# What must be installed to run it: the node and node_modules of today, the executable later.
installed() {
  local first=${HOWL_BIN%% *} path bytes
  path=$(command -v "$first") || { echo "bench: $first is not on the PATH" >&2; return 0; }
  if [ "$(basename "$path")" = node ]; then
    # The real binary: `node` on the PATH may be a shim, and a distribution's node may hold its engine in a library.
    local exe lib
    exe=$(node -p 'process.execPath' 2> /dev/null || echo "$path")
    I_NAME+=("node"); I_BYTES+=("$(stat -L -c %s "$exe")")
    lib=$(ldd "$exe" 2> /dev/null | awk '/libnode/ { print $3; exit }')
    [ -z "$lib" ] || { I_NAME+=("libnode"); I_BYTES+=("$(stat -L -c %s "$lib")"); }
    if [ -d "$ROOT/node_modules" ]; then
      I_NAME+=("node_modules"); I_BYTES+=("$(($(du -sLk "$ROOT/node_modules" 2> /dev/null | cut -f1) * 1024))")
    fi
  else
    bytes=$(stat -L -c %s "$path")
    I_NAME+=("executable"); I_BYTES+=("$bytes")
  fi
  if [ $JSON -eq 0 ]; then
    local i
    for i in "${!I_NAME[@]}"; do printf '%-44s %-12s %s bytes\n' "installed: ${I_NAME[$i]}" "" "${I_BYTES[$i]}"; done
  fi
}

# The demo as a second workload ---------------------------------------------------------------------------------------

# The steps, in the order the README plays them. `show` and `status` only look and are kept, not timed.
DEMO_STEPS=(reset history task open review fix approve merge busy dismiss claim tamper cut header unclassified trace config names person bundle gitlog secret)

demo_env() { env -i PATH="$PATH" HOME="$W/home" TZ=UTC HOWL="$HOWL_BIN" HOWL_HOME="$W/demo-home" "$@"; }

demo() {
  [ -f "$DEMO/demo/run" ] || die "$DEMO has no demo/run"
  cp -a "$DEMO" "$W/demo" || die "the demo could not be copied"
  local keepdir=$W/keep i step n t0 t1 skipped=() status
  mkdir -p "$keepdir"
  declare -A TIMES PEAK SKIP
  for ((i = 0; i <= RUNS; i++)); do
    n=0
    for step in "${DEMO_STEPS[@]}"; do
      n=$((n + 1))
      [ -z "${SKIP[$step]:-}" ] || continue
      t0=$(now_ns)
      (cd "$W/demo" && demo_env /usr/bin/time -f %M -o "$W/mem" demo/run "$step" > "$W/out" 2> "$W/err" < /dev/null)
      status=$?
      t1=$(now_ns)
      MEM=$(tail -n 1 "$W/mem" 2> /dev/null)
      case $MEM in '' | *[!0-9]*) MEM=0 ;; esac
      if [ $status -ne 0 ]; then
        SKIP[$step]="exit $status: $(grep -v '^[[:space:]]*$' "$W/err" | head -n 1 | cut -c1-120)"
        continue
      fi
      if [ $i -gt 0 ]; then
        TIMES[$step]="${TIMES[$step]:-} $(((t1 - t0) / 1000))"
        [ "$MEM" -le "${PEAK[$step]:-0}" ] || PEAK[$step]=$MEM
      else
        # What the step left, kept from the warm-up so that the timed runs are not disturbed by it.
        local base
        base=$(printf '%02d-%s' "$n" "$step")
        (cd "$W/demo" && demo_env $HOWL_BIN show 21 > "$keepdir/$base.show.txt" 2>&1; echo "exit: $?" >> "$keepdir/$base.show.txt"
          demo_env $HOWL_BIN status --json > "$keepdir/$base.status.json" 2>&1; echo "exit: $?" >> "$keepdir/$base.status.json") < /dev/null
      fi
    done
  done
  for step in "${DEMO_STEPS[@]}"; do
    if [ -n "${SKIP[$step]:-}" ]; then
      record demo "demo $step" "" 0 "${SKIP[$step]}"
    else
      # shellcheck disable=SC2086
      record demo "demo $step" "" "${PEAK[$step]:-0}" "" ${TIMES[$step]}
    fi
  done
  if [ -n "$KEEP" ]; then
    mkdir -p "$KEEP" && cp -a "$keepdir"/. "$KEEP"/
    echo "bench: the outputs of the demo are kept in $KEEP" >&2
  fi
}

[ "$ONLY" = demo ] || seeded
if [ -n "$DEMO" ] && [ "$ONLY" != seeded ]; then demo; fi

# The result ---------------------------------------------------------------------------------------------------------

CLOCK_END=$(clock_mhz)
cpu=$(awk -F: '/^model name/ { sub(/^ /, "", $2); print $2; exit }' /proc/cpuinfo 2> /dev/null)
cores=$(grep -c '^processor' /proc/cpuinfo 2> /dev/null)
node_version=$(node --version 2> /dev/null)
commit=$(git -C "$ROOT" rev-parse HEAD 2> /dev/null)
[ -z "$(git -C "$ROOT" status --porcelain 2> /dev/null)" ] || commit="$commit+dirty"
demo_commit=
if [ -n "$DEMO" ] && [ "$ONLY" != seeded ]; then
  demo_commit=$(git -C "$DEMO" rev-parse HEAD 2> /dev/null)
  [ -z "$(git -C "$DEMO" status --porcelain 2> /dev/null)" ] || demo_commit="$demo_commit+dirty"
fi

if [ $JSON -eq 0 ]; then
  echo "# machine: ${cpu:-unknown}, ${cores:-?} cores; clock ${CLOCK_START} MHz at the start, ${CLOCK_END} MHz at the end, ${CLOCK_MAX} MHz at most"
  echo "# node: ${node_version:-none}; howl: $HOWL_BIN; commit: ${commit:-none}${demo_commit:+; demo: $demo_commit}"
  echo "# runs: $RUNS after one warm-up; seed: $SEED; sizes: $SIZES; kernel: $(uname -sr)"
  exit 0
fi

echo "{"
echo "  \"machine\": {\"cpu\": \"$(jesc "$cpu")\", \"cores\": ${cores:-0}, \"clock_mhz_start\": $CLOCK_START, \"clock_mhz_end\": $CLOCK_END, \"clock_mhz_max\": $CLOCK_MAX, \"kernel\": \"$(jesc "$(uname -sr)")\"},"
echo "  \"node\": \"$(jesc "$node_version")\","
echo "  \"howl\": \"$(jesc "$HOWL_BIN")\","
echo "  \"commit\": \"$(jesc "$commit")\","
echo "  \"demo_commit\": \"$(jesc "$demo_commit")\","
echo "  \"runs\": $RUNS,"
echo "  \"seed\": $SEED,"
echo "  \"sizes\": [$SIZES],"
echo "  \"cases\": ["
for i in "${!R_KEY[@]}"; do
  line="    {\"group\": \"${R_GROUP[$i]}\", \"name\": \"$(jesc "${R_KEY[$i]}")\""
  [ -z "${R_LINES[$i]}" ] || line="$line, \"lines\": ${R_LINES[$i]}"
  if [ -n "${R_NOTE[$i]}" ]; then
    line="$line, \"skipped\": \"$(jesc "${R_NOTE[$i]}")\"}"
  else
    line="$line, \"median_ms\": $(ms "${R_MED[$i]}"), \"p90_ms\": $(ms "${R_P90[$i]}"), \"peak_kb\": ${R_MEM[$i]}}"
  fi
  [ "$i" -eq $((${#R_KEY[@]} - 1)) ] || line="$line,"
  echo "$line"
done
echo "  ],"
echo "  \"installed\": ["
for i in "${!I_NAME[@]}"; do
  line="    {\"name\": \"$(jesc "${I_NAME[$i]}")\", \"bytes\": ${I_BYTES[$i]}}"
  [ "$i" -eq $((${#I_NAME[@]} - 1)) ] || line="$line,"
  echo "$line"
done
echo "  ]"
echo "}"
