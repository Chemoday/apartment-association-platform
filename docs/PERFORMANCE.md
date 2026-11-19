# Performance of one installation

Measured on 2026-11-19 (issue [#168](https://github.com/Chemoday/apartment-association-platform/issues/168))
with the tools in [tests/load/](../tests/load/README.md). The numbers are for one installation as
docs/DEPLOYMENT.md deploys it (one backend process, one PostgreSQL, the deploy compose file and
its limits) and are meant to be compared with later runs of the same scenarios.

## Method

- **Host:** a rented test VPS (4 vCPU x86_64, 5.8 GB). The targets ran in one system container
  pinned to 3 cores with 4 GB; the load generator (Locust) in another, pinned to the fourth core.
  Docker Engine 29, the image of the commit under test.
- **Data:** `tests/load/seed_load.py`, one building with 60 or 120 apartments, about 1.5 residents
  per apartment, two meters each, 12 months of readings; the current month open.
- **Load:** `tests/load/locustfile.py`, a reading-deadline day where **every** resident is online at
  once for 10 minutes (deliberately harsher than real use, where readings come in over days):
  residents open the dashboard, submit two readings, look at their history and the forum; as many
  open tabs poll the unread count every 60 s; staff open the period matrix; one emergency fans out
  to everyone. 150 simulated users for 60 apartments, 300 for 120.
- **Measured:** CPU and memory of each container from its cgroup counters every 5-10 s
  (`tests/load/measure.sh`; they include every process of the container), latency percentiles from
  Locust, the costliest queries from `pg_stat_statements`, a `py-spy` profile of the backend.
  "Memory" below is the anonymous and shared memory that the kernel cannot reclaim; the page
  cache a container also uses is reclaimed under pressure.

## One installation

| Share of one core, idle or under the deadline-day load | 60 apartments | 120 apartments |
| :--- | :--- | :--- |
| Idle: backend + database (after issue #166) | about 1.6-2.3 % | the same |
| Requests per second | 4.6 | 9.2 |
| Backend, before the optimizations below | 14.9 % | 28.7 % |
| Backend, after | **12.6 %** | **24.3 %** |
| Database, before / after | 4.5 % / 3.6 % | 8.4 % / 6.9 % |
| Latency p95 / p99, before | 110 / 170 ms | 140 / 340 ms |
| Latency p95 / p99, after | **89 / 160 ms** | **110 / 200 ms** |
| Memory: backend + database | about 100 + 50 MiB | the same |

- The cost grows linearly with the requests: about 25 ms of CPU per request after the
  optimizations (30 ms before). The database executes the queries in fractions of a millisecond;
  almost all of the CPU is Python: asyncpg and SQLAlchemy around every query, then the
  FastAPI/Starlette/uvicorn stack. Telemetry and logging are about 3 %.
- One backend is one process and so at most one core (the GIL): under a burst it reaches 100 % of
  one core while the container may use 2 (the second core is for photo encoding and password
  hashing in threads, which release the GIL). That is about 40 requests per second per
  installation, far above what one association needs.

## Several installations on one host

Ten installations of 60 apartments on the 3 cores and 4 GB:

| | Total | Per installation |
| :--- | :--- | :--- |
| Idle, CPU | 16 % of one core | about 1.6 % |
| Idle, memory | about 1.25 GiB | about 125 MiB |
| All ten at their deadline-day peak at once, CPU | about 1.5 cores, 43 requests/s | about 15 % |
| The same, memory | about 1.5 GiB | about 150 MiB |
| The same, latency after the ramp-up | p95 120-150 ms, p99 210-350 ms, no errors | |
| 1500 users arriving within 30 s (the ramp-up itself) | about 100 requests/s for a minute: p95 of seconds, 2 connection resets | |

So a host of 4 vCPU and 8 GB holds roughly 40 installations by memory, and roughly 20-25 that all
reach this harsh peak at the same time; with real traffic (a fraction of the residents online at
once) more. The weak spot is a burst of arrivals on many installations in the same minute. CPU
steal on shared VPS cores lowers these numbers: measure again on the host that is chosen.

## Changes made from these measurements

| Change | Result |
| :--- | :--- |
| Health checks every 30 s, a stdlib socket check, compiled modules (issue #166) | idle 18 % -> 2.3 % of a core |
| Dashboard: the history of the user's meters in one query, only their readings, the previous and current period together | 6 data queries instead of 17 for two meters and the same for any number of meters (it grew by about 5 per meter); the rows read no longer grow with the size of the building (it read every reading of the period); dashboard p50 60 -> 38 ms |
| The caller and the memberships in one query (every request) | one query less on every authenticated request |

## Tried and not taken

| Idea | Measured | Why not |
| :--- | :--- | :--- |
| `shared_buffers=32MB`, `max_connections=40` for a small installation | database memory 50 -> 43 MiB | PostgreSQL only fills the buffers it reads, and the database of one association is small; 7 MiB is not worth a smaller cache once the data grow |
| `MALLOC_ARENA_MAX=2` for the backend | 101 -> 97 MiB | 4 MiB |
| Spans built although no exporter is configured | not among the visible costs of the profile (telemetry and logging together about 3 %) | the trace id of every response depends on them |

## Not measured yet

Photo uploads under load (Pillow memory against the 512 MB limit), the edge proxy for many
installations (here the generator called the backends directly), and a real association's traffic
(the pilot will show how much milder it is than this scenario).
