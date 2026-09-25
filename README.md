# GoSpaza — merchant application foundation

GoSpaza uses a modular Medusa v2 monolith and four independent Next.js applications. M0 provides infrastructure; M1 adds native authentication and actor-protected shells. See [M1 authentication setup and verification](docs/M1_AUTH.md) before starting the customer app, which now requires a native publishable API key. M2 adds applicant registration, private application documents and read-only admin review. See [M2 setup and verification](docs/M2_APPLICATIONS.md). Read AGENTS.md before changes; M3 approval/provisioning is not implemented.

## Repository and decisions

| Location | Responsibility |
| --- | --- |
| apps/backend | Medusa v2, infrastructure configuration, health routes, request logging |
| apps/customer | Customer shell, port 3000 |
| apps/merchant | Merchant/picker shell, port 3001 |
| apps/driver | Driver shell, port 3002 |
| apps/admin | Platform admin shell, port 3003 |
| packages/ui | Shared CSS tokens and Button |
| packages/contracts | Infrastructure TypeScript contracts |
| packages/api-client | Typed liveness and actor-specific native session clients |
| packages/config | Strict TypeScript, ESLint, environment validation |
| packages/test-utils | Isolated environment fixture; no business fixtures |
| scripts | Local environment setup and live HTTP smoke checks |

pnpm workspaces preserve apps/* and packages/* without adding a task runner. The root packageManager pins pnpm 10.11.1, workspace membership is defined in pnpm-workspace.yaml, and internal dependencies use workspace:* so they must resolve locally. Root .npmrc uses the four public-hoist-pattern entries from [Medusa's documented pnpm monorepo configuration](https://docs.medusajs.com/learn/configurations/pnpm). The temporary root tsconfig-paths workaround has been removed: no project source or script directly consumes it; dependencies that use it must resolve their own declared dependency. Medusa package versions are unchanged. pnpm 10's onlyBuiltDependencies allows install scripts for @swc/core, esbuild and sharp, which provide native build tooling; unexpected ignored-build warnings should be reviewed before proceeding. Frontend shared TypeScript packages are consumed as source through Next transpilePackages; their build scripts validate types rather than emit separate bundles. Configuration and test fixtures use CommonJS so Medusa's compiled server can consume them without compiling external source files. Keep the workspace packages available when running the built backend. The Medusa embedded Admin is enabled by default and can be disabled with DISABLE_MEDUSA_ADMIN=true; apps/admin provides authenticated, read-only application review. Medusa's native commerce modules remain authoritative; the M2 marketplace module adds only application and private-document metadata tables.

The Medusa package family is aligned at 2.18.0 from the [official starter](https://github.com/medusajs/medusa-starter-default). Redis event bus, workflow engine and locking use the [official infrastructure configuration](https://docs.medusajs.com/learn/deployment/general). Next.js uses the App Router and [manual installation structure](https://nextjs.org/docs/app/getting-started/installation).

## Prerequisites

- Node.js 22 LTS (see .nvmrc) and pnpm 10.11.1 (pinned in packageManager). If pnpm is absent, run `npm install --global pnpm@10.11.1` once to bootstrap the package manager; use pnpm for all repository dependency operations.
- Docker Engine/Desktop with Compose v2 and support for `up --wait`.
- Available ports: 5432 PostgreSQL, 6379 Redis, 9000 backend, 3000–3003 frontends.
- No cloud accounts or external service credentials are needed.

All commands below run at the repository root, including on Windows PowerShell. No global Medusa or Next CLI installation is required.

## First-time local setup

The M0 sequence below establishes infrastructure. For an existing checkout, use the ordered M2 commands in [docs/M2_APPLICATIONS.md](docs/M2_APPLICATIONS.md); M2 includes a new marketplace migration.

For an existing npm installation, follow the migration section below instead. Preserve existing environment files and database volumes.

1. Run `pnpm run env:setup`. It creates root .env, apps/backend/.env and frontend .env.local files from examples, generates independent JWT/cookie secrets and one matching database password, and never prints secrets. If any target exists it stops without overwriting existing configuration. In that case preserve existing files and manually create only missing ones from examples.
2. Run `pnpm install`. Review and commit the resulting pnpm-lock.yaml after successful dependency resolution. No lockfile was fabricated without an install. Subsequent local and CI installs should use `pnpm install --frozen-lockfile` with that committed lockfile.
3. Run `pnpm run lint`, `pnpm run typecheck`, and `pnpm test` for the fast checks.
4. Run `docker compose up -d --wait`. Services are named postgres and redis, with persistent project-scoped volumes and health checks. Published database ports bind only to loopback; Redis has no local password. This Compose file is for local development, not public deployment.
5. Run `pnpm run db:migrate`. Compose creates the configured database; Medusa applies its native migrations and module links. No seed or admin user is required for M0. This mutates the configured database: use the local development configuration.
6. Configure the customer publishable key using docs/M1_AUTH.md, then run `node scripts/dev-supervisor.mjs` (or root `pnpm run dev`). It supervises all five applications; see the development process lifecycle section for shutdown and verification. Leave this terminal running. In another terminal, run `pnpm run test:smoke`.
7. Inspect each frontend in a browser at ports 3000–3003. Each login page must identify its app. Verify the M1 auth flows described in docs/M1_AUTH.md on narrow and wide layouts.
8. Stop development with Ctrl+C before `pnpm run build`, to avoid sharing .next output with dev servers. Build compiles all five applications and checks the shared TypeScript packages.

The environment setup command is optional when environment variables are already supplied by the host. It does not install packages or start services. If interrupted while writing files, it will preserve what was written; complete the remaining examples manually. Environment files are ignored by Git. Never put real secrets in example files.

## Correct an existing npm installation

Stop running application processes first. Keep the existing .env files and PostgreSQL/Redis volumes; do not reset the database or rerun env:setup. Core migrations already applied must be preserved. The commands below are for the developer to run; Codex has not run them.

1. If pnpm is not already installed, bootstrap the pinned version:

   ```powershell
   npm install --global pnpm@10.11.1
   ```

   Expected: pnpm 10.11.1 is available. Stop on failure.

2. From PowerShell, remove only old dependency directories and npm lockfiles. Missing paths are skipped; every target is checked to remain inside the repository:

   ```powershell
   Set-Location -LiteralPath 'D:\Programming_projects\GoSpazaCodex'
   $repoPath = (Resolve-Path -LiteralPath '.').Path
   $cleanupPaths = @('node_modules', 'package-lock.json')
   foreach ($workspacePath in @('apps/admin', 'apps/backend', 'apps/customer', 'apps/driver', 'apps/merchant', 'packages/api-client', 'packages/config', 'packages/contracts', 'packages/test-utils', 'packages/ui')) {
       $cleanupPaths += Join-Path $workspacePath 'node_modules'
       $cleanupPaths += Join-Path $workspacePath 'package-lock.json'
   }
   foreach ($relativePath in $cleanupPaths) {
       $targetPath = [System.IO.Path]::GetFullPath((Join-Path $repoPath $relativePath))
       if (-not $targetPath.StartsWith($repoPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
           throw "Cleanup target is outside the repository: $targetPath"
       }
       if (Test-Path -LiteralPath $targetPath) {
           Remove-Item -LiteralPath $targetPath -Recurse -Force -ErrorAction Stop
       }
   }
   ```

   Expected: old root/workspace node_modules and package-lock.json files are gone. Stop on any removal failure. No .env, source, PostgreSQL or Redis data is removed.

3. Run `pnpm install` at the repository root. Expected: all workspace packages install, internal workspace links resolve locally, and pnpm-lock.yaml is generated. Stop on failure; review any ignored dependency build-script warning before continuing. Review and commit pnpm-lock.yaml and the removal of package-lock.json. Subsequent installs and CI use `pnpm install --frozen-lockfile`.

4. With the existing PostgreSQL/Redis services available, run `pnpm run db:migrate`. This delegates to `pnpm --filter @gospaza/backend run db:migrate`. Expected: native migrations and link-module synchronization both finish successfully, without the missing link-modules or createPlan errors. Stop on failure and retain the complete output. Do not reset the database.

5. Run `pnpm run lint`, then `pnpm run typecheck`, then `pnpm test`. Expected: each exits zero. Stop at the first failure.

6. Run `pnpm run dev`; leave it running. In a second terminal run `pnpm run test:smoke` and inspect each frontend in a browser. Expected: five processes start, liveness/readiness and all four shells pass, and narrow/wide layouts render correctly. Stop on failure.

7. Stop development with Ctrl+C, then run `pnpm run build`. Expected: every application builds and shared package checks pass. Stop on failure.

No pnpm lockfile was generated by Codex, and the existing npm lockfile and installed dependencies are deliberately left for the cleanup above.

## Development process lifecycle

Root `dev` now runs `node scripts/dev-supervisor.mjs`. The supervisor keeps the existing five workspace dev scripts and invokes pnpm's JavaScript entry directly, without launching pnpm.cmd for each app. No production start scripts or Medusa server/worker settings change.

For Windows PowerShell, start the supervisor directly from the repository root:

```powershell
node scripts/dev-supervisor.mjs
```

This is the same entry point as root dev and avoids an outer package-manager batch shim. `pnpm run dev` also invokes the supervisor, but if your pnpm installation is reached through pnpm.cmd, that outer batch process belongs to the caller and can still produce its own batch prompt. Direct Node startup removes that wrapper; no prompt suppression or terminal auto-reply is used.

Hierarchy: terminal → supervisor → five isolated Node launchers → pnpm running each unchanged workspace dev script → Medusa/Next and their children. Logs are prefixed with backend/customer/merchant/driver/admin. Startup prints the supervisor, launcher and pnpm PIDs.

Press Ctrl+C in the startup terminal and wait for the supervisor's final message. SIGINT and supported SIGTERM enter one idempotent shutdown path; repeated signals do not launch cleanup twice. An unexpected dev-script/launcher exit shuts down the other applications and produces a nonzero exit status.

On Windows each launcher starts detached from the controlling console. The supervisor explicitly runs taskkill /PID <launcher-pid> /T /F for every application tree and observes launcher/output closure. This is forced development-process termination, not graceful production shutdown. On non-Windows systems each launcher is a process-group leader: shutdown sends SIGTERM to the whole group, allows four seconds, then sends SIGKILL to any remaining group. Cleanup waits are bounded; errors/timeouts are reported rather than claimed as successful. IPC disconnection also triggers a launcher-side cleanup attempt if the supervisor disappears.

Keep the terminal open until shutdown completes. OS-level forced termination and applications that deliberately detach into unrelated groups are outside the normal signal lifecycle. PostgreSQL/Redis are not children of this supervisor and remain running.

### Windows lifecycle verification

Run each command as a single line. Existing app environment, dependencies and infrastructure must already be available. No commands below were executed by Codex.

1. In terminal A, run `node scripts/dev-supervisor.mjs`. Expect five prefixed startup streams and normal app readiness. Stop if an app fails.
2. In terminal B, capture the supervisor and current descendant identities, entering the printed supervisor PID:

```powershell
$goSpazaSupervisorPid = [int](Read-Host 'Supervisor PID printed at startup'); $goSpazaSnapshot = @(Get-CimInstance Win32_Process); $goSpazaDevPids = @($goSpazaSupervisorPid); do { $goSpazaPreviousCount = $goSpazaDevPids.Count; $goSpazaDevPids = @($goSpazaDevPids + @($goSpazaSnapshot | Where-Object { $_.ParentProcessId -in $goSpazaDevPids } | Select-Object -ExpandProperty ProcessId) | Sort-Object -Unique) } while ($goSpazaDevPids.Count -gt $goSpazaPreviousCount); $goSpazaTracked = @($goSpazaSnapshot | Where-Object { $_.ProcessId -in $goSpazaDevPids }); $goSpazaTracked | Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

Expect the supervisor, five launchers, pnpm/script wrappers and dev processes. Capture after all apps start. This tracks descendants even when their command lines do not contain the repository name.

3. Press Ctrl+C in terminal A. Expect a single shutdown announcement, then Development trees stopped and the prompt returning. Repeated Ctrl+C should not duplicate cleanup. In terminal A, inspect the exit status:

```powershell
$LASTEXITCODE
```

Expected: 0 for normal shutdown. Stop on errors.

4. In terminal B, check the recorded process identities, including Node and wrappers (creation time excludes recycled PIDs):

```powershell
Get-CimInstance Win32_Process | Where-Object { $goSpazaCurrent = $_; @($goSpazaTracked | Where-Object { $_.ProcessId -eq $goSpazaCurrent.ProcessId -and $_.CreationDate -eq $goSpazaCurrent.CreationDate }).Count -gt 0 } | Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

Expected: no rows. Also check GoSpaza-associated Node command lines for processes created after the snapshot:

```powershell
$goSpazaRepoPattern = [regex]::Escape((Resolve-Path -LiteralPath '.').Path); Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match $goSpazaRepoPattern } | Select-Object ProcessId, ParentProcessId, CommandLine
```

Review any rows; these can include intentionally running tools in the repository. The commands do not terminate anything.

5. Check dev listening ports, both while running and after shutdown:

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 9000,3000,3001,3002,3003 } | Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected: the configured apps while running, no listeners after shutdown. Stop and inspect ownership if any remain; do not kill unrelated processes.

Optional failure-path check: restart, then stop one of the printed pnpm PIDs in terminal B. Expect the supervisor to shut down the other apps and exit nonzero; repeat the process/port checks.

```powershell
Stop-Process -Id ([int](Read-Host 'pnpm PID printed for the development app to stop'))
```

## Commands

| Operation | Command |
| --- | --- |
| Install (first lockfile creation) | pnpm install |
| Install (committed lockfile) | pnpm install --frozen-lockfile |
| All development processes | pnpm run dev |
| One app | pnpm --filter @gospaza/customer run dev |
| Backend only | pnpm --filter @gospaza/backend run dev |
| Lint everything | pnpm run lint |
| Typecheck everything | pnpm run typecheck |
| Unit/config tests | pnpm test |
| Backend unit tests only | pnpm --filter @gospaza/backend run test |
| API client tests only | pnpm --filter @gospaza/api-client run test |
| Live HTTP smoke | pnpm run test:smoke |
| Build everything | pnpm run build |
| One app build | pnpm --filter @gospaza/merchant run build |
| Medusa migrations | pnpm run db:migrate |
| Stop local infrastructure, preserve data | docker compose down |

Use customer, merchant, driver, admin or backend in workspace filters. Root scripts propagate failures. `typecheck` runs Next type generation before tsc so it also works on clean checkouts; it requires the frontend environment configuration. Unit tests use Node's test runner with tsx for TypeScript and do not require running services. The live smoke command asserts actual PostgreSQL/Redis readiness through the backend, JSON responses, request IDs, cache headers, and all four rendered shells. It fails non-zero on a missing process or bad response. Override targets with SMOKE_BACKEND_URL and SMOKE_CUSTOMER_URL / SMOKE_MERCHANT_URL / SMOKE_DRIVER_URL / SMOKE_ADMIN_URL when ports differ.

## Environment separation

| Environment | APP_ENV | NODE_ENV | Source |
| --- | --- | --- | --- |
| Local dev | development | development (CLI default) | backend .env; frontend .env.local |
| Isolated tests | test | test | in-memory fixture; optional backend .env.test |
| Staging | staging | production | injected settings or production examples adapted for staging |
| Production | production | production | injected settings / secrets |

Medusa loads environment files using NODE_ENV. Never set NODE_ENV=staging. For staging, use APP_ENV=staging with NODE_ENV=production. Frontend public API URLs are build-time values: supply the correct environment before type generation and build. Keep local .env.local files out of staging/production, where they would override file-based defaults. Both production and staging require HTTPS browser/backend origins. Production Redis uses rediss in the example; PostgreSQL TLS must be configured for the selected infrastructure without disabling certificate verification.

DATABASE_URL configures Medusa PostgreSQL; REDIS_URL configures session storage and Redis event/workflow/locking modules. BACKEND_URL documents and validates the backend's external origin; it does not set its listener address. NEXT_PUBLIC_API_URL is the public API origin and contains no secrets. STORE_CORS, ADMIN_CORS and AUTH_CORS require explicit origins, never wildcard regexes. JWT_SECRET and COOKIE_SECRET must be generated independently, at least 32 characters, and contain no placeholder markers. Set PORT in the backend process environment if 9000 is unavailable.

Optional apps/backend/.env.test.example reserves a database ending in _test and Redis database /1. The runtime validator rejects a test configuration aimed at the normal development database or Redis /0. M0 unit tests never connect to the fixture URLs. If adding integration suites later, provision that separate database and run migrations with NODE_ENV=test and APP_ENV=test; do not migrate development data from a test command. Staging/production must use separate PostgreSQL and Redis instances/credentials from development.

For an application running in a container on the Compose network, use postgres:5432 and redis:6379 in connection URLs; localhost URLs are for host-run apps. Configuration uses environment variables and logs go to stdout. No application image or deployment pipeline is included.

After building, frontend `pnpm --filter @gospaza/customer run start` (and corresponding app names) serves the production build. Backend `pnpm --filter @gospaza/backend run start` runs in apps/backend/.medusa/server. Supply production variables to that process, or for a local built-server check copy the local backend .env into apps/backend/.medusa/server/.env and set NODE_ENV=production in the process environment. The generated server is not a standalone deployable artifact without dependencies and the shared configuration package. Production deployment packaging is outside M0.

## Backend worker mode and Medusa Admin

The backend maps validated environment settings to Medusa's projectConfig.workerMode and admin.disable, following the [Medusa worker-mode configuration](https://docs.medusajs.com/learn/production/worker-mode).

| Instance | MEDUSA_WORKER_MODE | DISABLE_MEDUSA_ADMIN |
| --- | --- | --- |
| Local development / combined process (defaults) | shared | false |
| Dedicated production HTTP server | server | false |
| Dedicated production background worker | worker | true |

MEDUSA_WORKER_MODE accepts exactly shared, server or worker and defaults to shared only when unset. DISABLE_MEDUSA_ADMIN accepts exactly true or false and defaults to false only when unset. Empty strings, unsupported values and incorrect casing fail with an error naming the variable. The flags are independent: set both explicitly for a dedicated worker; choosing worker does not automatically disable Admin.

Supply these settings when building and starting the relevant instance so its Admin build and runtime configuration agree. Existing local environment files can omit both variables to use the defaults. The production example retains the combined-process defaults; override the two settings per instance using the table above. These settings configure the existing backend only; no deployment infrastructure or additional application is created.

## Health and logging

- GET /health/live returns HTTP 200 with {"status":"ok"}; it does not query dependencies.
- GET /health/ready returns HTTP 200 only when PostgreSQL SELECT 1 and Redis PING succeed; otherwise HTTP 503 with sanitized up/down fields. It checks connectivity, not migration version or every Medusa worker. Calls have connection/query timeouts; overlapping requests share a probe and cache its result for one second. Both routes disable HTTP caching.
- Medusa's native /health remains unchanged; use the explicit routes above for this project's monitoring contract.
- Every request reaching the custom middleware receives a server-generated X-Request-ID; downstream code can access res.locals.requestId. Completion logs are JSON with timestamp, level, event, request ID, method, status and duration. Bodies, query strings, cookies, auth headers and connection errors are excluded. Medusa's own startup/internal logs retain its default logger. This is a request logging baseline, not full tracing.
- The typed API client's health operation is ready for server-side use. Cross-origin browser health requests are not enabled in M0. M1 actor clients and their session/CORS policies are documented in docs/M1_AUTH.md.

## CI readiness and verification limits

Once the first install has produced a reviewed, committed lockfile, CI can run pnpm install --frozen-lockfile, lint, typecheck, test and build noninteractively with environment variables supplied. To run test:smoke, provision PostgreSQL/Redis, migrate a disposable database and start the five apps first. No provider-specific CI or deployment workflow is introduced.

The pnpm correction was reviewed statically only; Codex ran no shell commands or verification. User-supplied output showed Medusa's native migrations completed under npm, then link-module initialization/synchronization failed because @medusajs/medusa/link-modules could not resolve (followed by the createPlan error). The overall migration has not succeeded yet. Retry it after a clean pnpm installation; dependency resolution, full migration including link synchronization, lint, typechecks, tests, builds and runtime smoke checks remain unverified under pnpm. M1 adds authentication only. Merchant/driver business models, catalogue, checkout, dispatch, payments, compliance and finance remain unimplemented.
