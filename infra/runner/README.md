# Isolated runner controller

The runner-controller is a trusted private service. Build its shaded jar with
`bash ./mvnw -pl apps/runner-controller -am package`. Its entrypoint is
`dev.javablueprints.runner.RunnerController`. The service needs Docker CLI access
to the Linux engine. `JB_RUNNER_TOKEN_FILE` reads a server-only secret mount;
`JB_RUNNER_TOKEN` is supported for local development. Both require at least 32 characters.
The default port is 8091, overridden by `JB_RUNNER_PORT` and `JB_RUNNER_BIND`.

Compose integration: build this Dockerfile using repository context; mount
`/var/run/docker.sock` exclusively on this trusted controller, attach it only to
the internal runner-control network, expose port 8091 internally, and publish no host
port. Give only the backend worker the bearer token. Public API containers must
not receive Docker socket access. Sandbox containers use network none and no
mounts. The controller copies bounded ustar bytes with a fixed tar command into
tmpfs; only fixed java/javac commands execute code. No application source is
executed on the controller or host JVM.

Internal API: bearer authorization on all routes. POST `/internal/v1/executions`
accepts RunnerProtocol.Submit plus `Idempotency-Key` job:attempt:execution. GET
`/internal/v1/executions/{id}` and POST its `/cancel` require X-Project-Id,
X-Job-Id, X-Attempt-Id, X-Spec-Hash, X-Fencing-Token. POST
`/internal/v1/attempts/{id}/renew` requires project/job/fence headers and JSON
leaseExpiresAt. GET `/internal/v1/health` tests engine/image/seccomp/cgroup-v2.
Java integration uses RunnerClient from the verification artifact; compileSpec,
runtimeSpec and compare implement compile-only, single-run and paired comparison.

Profile java21-v1 binds its fixed SHA256 profile hash into every execution hash.
Source transport supports package-relative Java files including package-info and
module-info, ASCII Java identifiers, 100 files / 1 MiB source, 1 MiB stdin, 100 args / 64 KiB,
8 MiB class bytes / 1000 classes, 1 MiB combined output, and a 16 MiB request body. Sandboxes
use 512 MiB RAM with no swap, 1 CPU, 128 PIDs, UID 65534, a read-only root, no capabilities,
no-new-privileges, built-in seccomp, no network, a 64 MiB workspace tmpfs and 16 MiB
temporary tmpfs. Compilation has a 20-second limit, runtime a 5-second limit, and Java a fixed 256 MiB heap. A new container/JVM
is used per execution, with annotation processors disabled.

Current operational limits: singleton controller, 2 workers, 32 nonterminal
executions, 1024 retained execution handles, 64 MiB aggregate retained bytes and
10-minute execution retention. Controller restart reconciles/removes its namespaced labeled
sandboxes, discards temporary artifacts, and old handles become unavailable;
the durable backend must allocate a fresh attempt/fence. This prototype has no
durable controller execution journal and cannot retain idempotency across its
restart. It is not approved for public multi-tenant execution. Failed cleanup
is explicit cleanupPending; pending cleanup must prevent claiming success.


## Repeat the execution integration checks

Build the Java modules before building the controller image. These commands run
on a Linux host with JDK21, Docker, Maven Wrapper and OpenSSL available:

```bash
MAVEN_USER_HOME="$PWD/.local/cache/maven-wrapper" bash ./mvnw -B -ntp -DskipTests package
docker pull eclipse-temurin@sha256:742daacb9316be4b6fc60258f6e4ac2a11882f6c597373c92290a57bfad0d2e0
docker build -f infra/runner/Dockerfile -t java-blueprints-runner:local .
export JB_RUNNER_TEST_TOKEN="$(openssl rand -hex 32)"
docker run --detach --name java-blueprints-runner-test \
  --publish 127.0.0.1:18093:8091 \
  --env JB_RUNNER_TOKEN="$JB_RUNNER_TEST_TOKEN" \
  --env JB_RUNNER_NAMESPACE=integration-check \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --read-only --tmpfs /tmp:rw,size=64m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  java-blueprints-runner:local
export JB_RUNNER_INTEGRATION=true
export JB_RUNNER_TEST_URL=http://127.0.0.1:18093
MAVEN_USER_HOME="$PWD/.local/cache/maven-wrapper" bash ./mvnw -B -ntp -pl apps/runner-controller -am test
docker stop java-blueprints-runner-test
docker rm java-blueprints-runner-test
```

The published loopback port is used only for this explicit test controller. The
application's Compose controller has no published port. Test artifacts are written
to `apps/runner-controller/target/test-artifacts` by default; `JB_EVIDENCE_DIR`
can select another local output directory. Never expose the controller token to
the browser or share it in logs.
