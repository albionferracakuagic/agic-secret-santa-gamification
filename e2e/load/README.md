# Load testing (ADR-0006)

| Tool           | Where it runs                          | Purpose                                                                                                      |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `harness.ts`   | Local, in-process server + PGlite      | Regression check of the TR-003 targets: connect, REST p95, board/phase push to every client, reconnect storm |
| `k6-socket.js` | Against a deployed staging environment | Network-realistic socket + REST scenario (not yet run: needs staging and seeded cookies)                     |

## Local harness

```
npx tsx e2e/load/harness.ts --events 5 --clients 100 --batch 25      # report + PASS/FAIL per ADR-0006 target
npx tsx e2e/load/harness.ts --events 5 --clients 100 --strict        # exit 1 on any breach
```

Options: `--events` (default 5), `--clients` per event (100), `--batch` max concurrent connects/requests (25), `--reconnect` storm ratio (0.3).

Read the numbers with care: server and every client share one Node process and CPU, and the database is PGlite
(single-threaded WASM). Push latency is therefore pessimistic for the server and blind to network latency.
Do not raise `--batch` to 100 on PGlite: 100 simultaneous snapshot loads crashed the WASM runtime
(exit `0xC0000409`) on the dev machine; against real Postgres a connection pool (~10) serialises that load.
