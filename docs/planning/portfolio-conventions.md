# Kontourai new-package conventions — for lookout L1 bootstrap

Exemplars: kontourai/traverse (deps + subpaths) and kontourai/datum (zero-dep + CLI bin). Copy their shape.

## package.json skeleton (lookout)

```json
{
  "name": "@kontourai/lookout",
  "version": "0.1.0",
  "description": "Web source monitoring: registered sources, cheap drift checks, typed change events with provenance.",
  "license": "Apache-2.0",
  "type": "module",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/kontourai/lookout.git" },
  "exports": { ".": { "types": "./dist/src/index.d.ts", "default": "./dist/src/index.js" } },
  "bin": { "lookout": "bin/lookout.mjs" },
  "files": ["dist/src/", "bin/", "README.md", "LICENSE"],
  "scripts": {
    "build": "rm -rf dist && tsc",
    "prepare": "npm run build",
    "typecheck": "tsc --noEmit",
    "test": "npm run build && node --test dist/tests/*.test.js",
    "verify": "npm run typecheck && npm test"
  },
  "dependencies": {
    "@kontourai/traverse": "^0.8.0"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^5.8.0"
  },
  "engines": { "node": ">=22" }
}
```

Dependency notes:
- `@kontourai/traverse` ^0.8.0 and `@kontourai/survey` ^1.5.0 are on npm.
- `@kontourai/datum` (0.3.0) is NOT yet published — declare as `"@kontourai/datum": "github:kontourai/datum"`. Its README's stated interim consumption mode is "from the repo".
- Add `@kontourai/survey` only at L3 (runtime dep — allowed; lookout is a composition layer per the shaping decision). Add datum at L1 (CLI provider resolution), survey at L3.

## tsconfig.json (identical across traverse/datum — copy verbatim)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

## Layout

```
src/index.ts            # public exports only
src/<modules>.ts
tests/*.test.ts         # node:test, run compiled from dist/tests/
bin/lookout.mjs         # thin CLI shim importing dist/src/cli.js
docs/adr/               # frozen ADRs + index.md
docs/decisions/         # living decisions + index.md
CONTEXT.md              # term glossary
AGENTS.md               # agent guidance: source of truth, match-checks-to-change-type, useful commands
README.md, LICENSE
.github/workflows/ci.yml
release-please-config.json, .release-please-manifest.json
```

## CI (ci.yml — matches traverse/datum)

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  secret-scan:
    name: Secret Scan
    uses: kontourai/.github/.github/workflows/secret-scan.yml@main
    permissions: { contents: read }
  verify:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: { node-version: ['22', '24'] }
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with: { node-version: '${{ matrix.node-version }}', cache: npm }
      - run: npm ci
      - run: npm run verify
```

release-please-config.json: copy traverse's (`release-type: node`, `include-component-in-tag: false`, standard changelog-sections, `"packages": { ".": {} }`).

## Style rules observed in the portfolio

- No eslint/prettier/biome — discipline comes from `strict` tsc + verify scripts.
- Never-throws discipline for operational failures: return typed errors on results (copy traverse's `FetchError` pattern for lookout's `CheckResult.error`).
- All time/randomness/network behind injectable seams (see FetchSourceOptions) so tests are deterministic and network-free.
- Subpath exports for optional concerns; root export stays small.
- ADR for each identity-level decision; docs/decisions/ for living ones.

## datum resolve() (for CLI provider resolution)

```typescript
import { resolve } from "@kontourai/datum";
// resolve(ref: string) -> { provider: string; kind: "anthropic-compatible" | ...; baseUrl?: string; apiKey: string; model: string }
// ref is a role name ("extraction-default") or "model@provider".
// Config: ~/.config/kontour/datum.json (user) deep-merged with .datum/config.json (repo), repo wins.
// Compose: createAnthropicExtractionProvider({ ...resolve(process.env.TRAVERSE_ROLE || "extraction-default") })
```
Campfit precedent for env precedence (copy it): `TRAVERSE_ROLE` (role), `TRAVERSE_MODEL` (model override), `ANTHROPIC_BASE_URL`, `TRAVERSE_MAX_TOKENS`.
