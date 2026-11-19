#!/usr/bin/env bash
# CPU and memory of containers from their cgroup counters (tests/load/README.md).
#
#   measure.sh <seconds> <interval> <container>...
#
# Prints one CSV line per container and interval (time, container, cpu % of one core, memory and
# anonymous memory in MiB) to stdout, and a summary per container to stderr. Memory includes the
# page cache of files the container read, which the kernel reclaims under pressure; anonymous
# memory (process heaps, shared buffers) cannot be reclaimed, so it is what decides how many
# installations fit on a host.
# The counters include every process of the container (health checks too), unlike `docker stats`
# samples. Runs on the Docker host as root (read-only).
set -euo pipefail

[[ $# -ge 3 && "$1" =~ ^[0-9]+$ && "$2" =~ ^[0-9]+$ && "$2" -gt 0 ]] \
    || { sed -n '4p' "$0" >&2; exit 2; }
SECONDS_TOTAL=$1
INTERVAL=$2
shift 2

cgroup_of() {  # <container> -> its cgroup directory
    local pid
    pid=$(docker inspect -f '{{.State.Pid}}' "$1")
    [[ "$pid" -gt 0 ]] || { echo "measure: $1 is not running" >&2; exit 1; }
    echo "/sys/fs/cgroup$(sed -n 's/^0:://p' "/proc/$pid/cgroup")"
}
cpu_usec() { awk '/^usage_usec/ {print $2}' "$1/cpu.stat"; }
mem_mib() { echo $(( $(cat "$1/$2") / 1048576 )); }
anon_mib() { awk '$1 == "anon" || $1 == "shmem" {sum += $2} END {print int(sum / 1048576)}' "$1/memory.stat"; }

declare -A dir last sum peak anon_peak
for c in "$@"; do
    dir[$c]=$(cgroup_of "$c")
    last[$c]=$(cpu_usec "${dir[$c]}")
    sum[$c]=0
    peak[$c]=0
    anon_peak[$c]=0
done

echo "time,container,cpu_pct,mem_mib,anon_mib"
start=$(date +%s%N)
prev=$start
samples=0
while (( ($(date +%s%N) - start) / 1000000000 < SECONDS_TOTAL )); do
    sleep "$INTERVAL"
    now=$(date +%s%N)
    elapsed_us=$(( (now - prev) / 1000 ))
    prev=$now
    samples=$((samples + 1))
    for c in "$@"; do
        usage=$(cpu_usec "${dir[$c]}")
        pct10=$(( (usage - last[$c]) * 1000 / elapsed_us ))  # tenths of a percent
        last[$c]=$usage
        sum[$c]=$(( sum[$c] + pct10 ))
        (( pct10 > peak[$c] )) && peak[$c]=$pct10
        anon=$(anon_mib "${dir[$c]}")
        (( anon > anon_peak[$c] )) && anon_peak[$c]=$anon
        printf '%s,%s,%d.%d,%s,%s\n' "$(date -u +%H:%M:%S)" "$c" $((pct10 / 10)) $((pct10 % 10)) \
            "$(mem_mib "${dir[$c]}" memory.current)" "$anon"
    done
done

for c in "$@"; do
    avg=$(( sum[$c] / (samples > 0 ? samples : 1) ))
    peak_mem=$( [[ -f "${dir[$c]}/memory.peak" ]] && mem_mib "${dir[$c]}" memory.peak || echo "?")
    printf 'summary %s: cpu avg %d.%d%% peak %d.%d%%, memory %s MiB (peak since start %s MiB), anon peak %s MiB\n' \
        "$c" $((avg / 10)) $((avg % 10)) $((peak[$c] / 10)) $((peak[$c] % 10)) \
        "$(mem_mib "${dir[$c]}" memory.current)" "$peak_mem" "${anon_peak[$c]}" >&2
done
