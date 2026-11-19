# Load tests

Tools to measure one installation under load and how many fit on one host (issue #168). The
method and the numbers are in [docs/PERFORMANCE.md](../../docs/PERFORMANCE.md).

| File | What |
| :--- | :--- |
| `seed_load.py` | Fills an **empty demo** installation with one building of N apartments (60 or 120), residents (about 1.5 per apartment), staff and 12 months of readings; writes the user ids to a JSON file |
| `locustfile.py` | The scenarios of a reading-deadline day (residents, open tabs polling the unread count, staff opening the period matrix, one emergency fan-out, optional photo uploads) |
| `target.sh` | Starts a target installation from `deploy/docker-compose.deploy.yml` plus `docker-compose.load.yml`, fills it and lists its costliest queries |
| `measure.sh` | CPU and memory of containers from their cgroup counters, every few seconds |

## Safety

- The tools only ever load a **demo** installation. `seed_load.py` refuses a database that is
  not marked as a demo or that already holds a building. The locustfile stops at once when
  `GET /api/v1/demo/users` does not answer 200 (it answers 404 without demo mode).
- Run them on a throw-away host, never next to real installations or unrelated services: a load
  test takes the CPU it can get.
- Results that name hosts or addresses stay out of the repository.

## Running

On the load host (Docker Engine 25+, a checkout of the repository, as root). Use the image of
the commit that is checked out: the generator runs the checkout's `tests/` against the image's
`src/`, so both must be the same version.

```sh
docker build -t aap-load:$(git rev-parse --short HEAD) .   # or pull the image of that commit
LOAD_BIND=10.0.0.5 bash tests/load/target.sh up 1 aap-load:$(git rev-parse --short HEAD) 60
bash tests/load/measure.sh 600 5 aap-load1-backend-1 aap-load1-db-1 > cpu.csv &
```

`LOAD_BIND` is the address the target's backend listens on (default `127.0.0.1`): a private
address that the load generator reaches, for example a container bridge or a VPN. Never a public
one: a demo lets anyone act as any user, and Docker's published ports bypass a host firewall.
`target.sh` refuses `0.0.0.0`.

From the machine that generates the load (ideally another host or a container with its own CPU):

```sh
uv sync --group load
LOAD_USERS=users.json uv run --group load locust -f tests/load/locustfile.py \
    --host http://<LOAD_BIND>:18001 --users 150 --spawn-rate 5 --run-time 10m --headless \
    --csv run1
bash tests/load/target.sh pgstat 1          # the costliest queries of the run
bash tests/load/target.sh down 1            # deletes the target and its data
```

`users.json` is `/srv/aap-load/load1/out/users.json` on the load host. `LOAD_PHOTOS=1` adds issue
reports with photos (the product accepts 1 encoding at a time plus 4 queued).
