#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export MAVEN_USER_HOME="$PWD/.local/cache/maven-wrapper"
for tool in java node pnpm docker curl; do command -v "$tool" >/dev/null || { echo "Missing prerequisite: $tool" >&2; exit 1; }; done
node --input-type=module <<'NODE'
import fs from 'node:fs';
import crypto from 'node:crypto';
if (!fs.existsSync('.env')) fs.copyFileSync('.env.example','.env');
let env=fs.readFileSync('.env','utf8');
for (const key of ['JB_DB_PASSWORD','JB_RUNNER_CONTROLLER_TOKEN']) {
 const pattern=new RegExp(`^${key}=(.*)$`,'m');
 const current=env.match(pattern)?.[1]?.trim();
 if (!current || current==='replace_with_local_random_secret') env=env.replace(pattern,`${key}=${crypto.randomBytes(32).toString('hex')}`);
}
fs.writeFileSync('.env',env,{mode:0o600});
NODE
bash ./mvnw -B -ntp -DskipTests package
pnpm install --frozen-lockfile --store-dir "$PWD/.local/cache/pnpm"
pnpm --dir apps/web build
docker pull eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0
docker compose --env-file .env -f infra/compose.yaml up -d --build
ready=false
for attempt in $(seq 1 60); do
 if curl --fail --silent http://127.0.0.1:5174/api/v1/health >/dev/null; then ready=true; break; fi
 sleep 1
done
if [ "$ready" != true ]; then echo 'Application readiness deadline exceeded' >&2; exit 1; fi
printf 'Java Blueprints ready: http://127.0.0.1:5174\n'
