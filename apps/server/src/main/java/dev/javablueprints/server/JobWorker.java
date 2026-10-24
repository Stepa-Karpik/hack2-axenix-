package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static dev.javablueprints.verification.RunnerProtocol.MAX_OUTPUT;

import dev.javablueprints.engine.*;
import dev.javablueprints.engine.EngineModel.*;
import dev.javablueprints.verification.*;
import dev.javablueprints.verification.RunnerProtocol.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class JobWorker {
  final java.util.concurrent.ScheduledExecutorService heartbeat =
      java.util.concurrent.Executors.newSingleThreadScheduledExecutor(
          r -> {
            Thread t = new Thread(r, "job-lease");
            t.setDaemon(true);
            return t;
          });
  static final String PROFILE_HASH = RunnerProtocol.PROFILE_HASH;
  final ThreadLocal<Long> deadline = new ThreadLocal<>();
  final java.util.concurrent.ExecutorService workers =
      java.util.concurrent.Executors.newFixedThreadPool(
          2,
          r -> {
            Thread t = new Thread(r, "durable-worker");
            t.setDaemon(true);
            return t;
          });
  final java.util.concurrent.atomic.AtomicBoolean
      analysisActive = new java.util.concurrent.atomic.AtomicBoolean(),
      executionActive = new java.util.concurrent.atomic.AtomicBoolean();
  final Workspace w;
  final ProgramEngine engine = new ProgramEngine();
  final RunnerClient runner;
  final boolean enabled;

  JobWorker(
      Workspace w,
      @Value("${jb.runner.enabled}") boolean enabled,
      @Value("${jb.runner.url}") String url,
      @Value("${jb.runner.token}") String token) {
    this.w = w;
    this.enabled = enabled;
    runner =
        new RunnerClient(
            URI.create(url == null || url.isBlank() ? "http://127.0.0.1:8091" : url), token);
  }

  boolean available() {
    return enabled && runner.available();
  }

  void requireAvailable() {
    if (!available()) throw new ApiError(503, "RUNNER_UNAVAILABLE", "Isolated runner unavailable");
  }

  @Scheduled(fixedDelay = 300)
  public void poll() {
    dispatch(analysisActive, true);
    dispatch(executionActive, false);
  }

  void dispatch(java.util.concurrent.atomic.AtomicBoolean active, boolean analysis) {
    if (active.compareAndSet(false, true))
      workers.execute(
          () -> {
            try {
              process(analysis);
            } finally {
              active.set(false);
            }
          });
  }

  void expireLeases() {
    w.tx.executeWithoutResult(
        tx -> {
          var expired =
              w.db.queryForList(
                  "SELECT id::text,project_id::text,attempt_id::text FROM jobs WHERE"
                      + " status='running' AND lease_until<now() ORDER BY id FOR UPDATE SKIP LOCKED"
                      + " LIMIT 100");
          for (var job : expired) {
            var j = uuid(job.get("id").toString());
            var p = uuid(job.get("project_id").toString());
            w.db.update(
                "UPDATE jobs SET"
                    + " status='failed',error='{\"code\":\"LEASE_EXPIRED\",\"message\":\"Attempt"
                    + " lease expired\"}'::jsonb,finished_at=now() WHERE id=? AND status='running'",
                j);
            if (job.get("attempt_id") != null)
              w.db.update(
                  "UPDATE job_attempts SET status='failed',finished_at=now() WHERE id=? AND"
                      + " status='running'",
                  uuid(job.get("attempt_id").toString()));
            w.db.update(
                "UPDATE resources SET data=jsonb_set(data,'{status}','\"rejected\"'::jsonb) WHERE"
                    + " project_id=? AND kind='proposal' AND data->>'jobId'=?",
                p,
                j.toString());
          }
        });
  }

  void process(boolean analysis) {
    expireLeases();
    Map<String, Object> row =
        w.tx.execute(
            tx -> {
              var rows =
                  w.db.queryForList(
                      "SELECT id::text,project_id::text,type,input::text FROM jobs WHERE"
                          + " status='queued' AND (type='analyze')=? ORDER BY created_at,id FOR"
                          + " UPDATE SKIP LOCKED LIMIT 1",
                      analysis);
              if (rows.isEmpty()) return null;
              var r = rows.getFirst();
              String attempt = id();
              w.db.update(
                  "UPDATE jobs SET status='running',attempt_id=?,lease_until=now()+interval '45"
                      + " seconds',started_at=now() WHERE id=?",
                  uuid(attempt),
                  uuid(r.get("id").toString()));
              w.db.update(
                  "INSERT INTO job_attempts(id,job_id,status)VALUES(?,?,'running')",
                  uuid(attempt),
                  uuid(r.get("id").toString()));
              r.put("attempt", attempt);
              return r;
            });
    if (row == null) return;
    String p = row.get("project_id").toString(),
        j = row.get("id").toString(),
        attempt = row.get("attempt").toString();
    var input = w.decode(row.get("input").toString());
    w.publication.set(new ArrayList<>());
    deadline.set(System.nanoTime() + java.time.Duration.ofSeconds(600).toNanos());
    var renewal =
        heartbeat.scheduleAtFixedRate(
            () -> {
              try {
                w.db.update(
                    "UPDATE jobs SET lease_until=now()+interval '45 seconds' WHERE project_id=? AND"
                        + " id=? AND attempt_id=? AND status='running' AND lease_until>now() AND"
                        + " started_at>now()-interval '600 seconds'",
                    uuid(p),
                    uuid(j),
                    uuid(attempt));
              } catch (Exception ignored) {
              }
            },
            10,
            10,
            java.util.concurrent.TimeUnit.SECONDS);
    try {
      Map<String, Object> result =
          switch (row.get("type").toString()) {
            case "analyze" -> analyze(p, input);
            case "change" -> change(p, j, attempt, input);
            case "compile" -> compile(p, j, attempt, input);
            case "run" -> run(p, j, attempt, input);
            case "compare" -> compare(p, j, attempt, input);
            default -> throw new ApiError(422, "UNSUPPORTED_OPERATION", "Unsupported job");
          };
      finish(p, j, attempt, result, null);
    } catch (Exception e) {
      if (row.get("type").equals("change")) {
        var proposal = w.resource(p, str(input, "proposalId"), "proposal");
        proposal.put("status", "rejected");
        proposal.put(
            "error",
            map(
                "code",
                e instanceof EngineException x
                    ? x.code()
                    : e instanceof ApiError x ? x.code : "JOB_FAILED",
                "message",
                "Change could not complete"));
        w.updateResource(p, str(input, "proposalId"), "proposal", proposal);
      }
      finish(
          p,
          j,
          attempt,
          null,
          map(
              "code",
              e instanceof ApiError x
                  ? x.code
                  : e instanceof EngineException x ? x.code() : "JOB_FAILED",
              "message",
              "Job could not complete"));
    } finally {
      renewal.cancel(false);
      w.publication.remove();
      deadline.remove();
    }
  }

  void finish(
      String p, String j, String attempt, Map<String, Object> result, Map<String, Object> error) {
    var pending = w.publication.get();
    w.publication.remove();
    w.tx.executeWithoutResult(
        tx -> {
          var rows =
              w.db.queryForList(
                  "SELECT cancel_requested_at IS NOT NULL AS cancelled FROM jobs WHERE project_id=?"
                      + " AND id=? AND attempt_id=? AND status='running' AND lease_until>now() FOR"
                      + " UPDATE",
                  uuid(p),
                  uuid(j),
                  uuid(attempt));
          if (rows.isEmpty()) return;
          boolean cancelled = Boolean.TRUE.equals(rows.getFirst().get("cancelled"));
          if (!cancelled && error == null && pending != null) pending.forEach(Runnable::run);
          if (cancelled || error != null) {
            w.db.update(
                "UPDATE resources SET data=jsonb_set(data,'{status}','\"rejected\"'::jsonb) WHERE"
                    + " project_id=? AND kind='proposal' AND data->>'jobId'=?",
                uuid(p),
                j);
          }
          w.db.update(
              "UPDATE jobs SET status=?,result=?::jsonb,error=?::jsonb,finished_at=now() WHERE"
                  + " project_id=? AND id=? AND attempt_id=? AND status='running'",
              cancelled ? "cancelled" : error == null ? "succeeded" : "failed",
              cancelled || error != null ? null : w.encode(result),
              error == null ? null : w.encode(error),
              uuid(p),
              uuid(j),
              uuid(attempt));
          w.db.update(
              "UPDATE job_attempts SET finished_at=now(),status=(SELECT status FROM jobs WHERE"
                  + " id=?)WHERE id=? AND status='running'",
              uuid(j),
              uuid(attempt));
        });
  }

  boolean cancelled(String p, String j) {
    return (deadline.get() != null && System.nanoTime() > deadline.get())
        || w.db.queryForObject(
            "SELECT cancel_requested_at IS NOT NULL OR status<>'running' OR lease_until<now() FROM"
                + " jobs WHERE project_id=? AND id=?",
            Boolean.class,
            uuid(p),
            uuid(j));
  }

  Map<String, Object> analyze(String p, Map<String, Object> in) {
    String r = str(in, "revisionId");
    Analysis a = engine.inspect(new SourceBundle(r, w.javaFiles(w.revision(p, r))));
    w.putResource(p, a.id(), "analysis", a);
    return map(
        "resultKind",
        "analysis",
        "analysisId",
        a.id(),
        "revisionId",
        r,
        "resultRef",
        "/api/v1/projects/" + p + "/revisions/" + r + "/analysis?analysisId=" + a.id());
  }

  Map<String, Object> change(String p, String j, String attempt, Map<String, Object> in)
      throws Exception {
    String base = str(in, "baseRevisionId"), proposalId = str(in, "proposalId");
    var rev = w.revision(p, base);
    Analysis analysis = w.convert(w.analysis(p, base, str(in, "analysisId")), Analysis.class);
    var command =
        new EditCommand(
            base,
            analysis.id(),
            str(in, "methodId"),
            str(in, "nodeId"),
            str(in, "operation"),
            ApiController.editPayload(in),
            str(in, "intent"));
    Candidate candidate = engine.propose(new SourceBundle(base, w.javaFiles(rev)), analysis, command);
    var candidateTree = new TreeMap<>(w.files(rev));
    candidateTree.putAll(candidate.files());
    Map<String, Object> saved =
        w.tx.execute(
            tx ->
                w.save(
                    p, base, candidateTree, Map.of(), w.directories(rev), "graph_edit", command.intent(), false));
    String r = saved.get("id").toString();
    var checks =
        map(
            "parseStatus",
            candidate.parseStatus(),
            "compileStatus",
            "unavailable",
            "verificationStatus",
            "not_requested");
    Map<String, Object> compiled = null;
    if (available()) {
      var execution =
          runner.execute(
              p, j, attempt, 1, RunnerClient.compileSpec(candidate.files()), () -> cancelled(p, j));
      compiled = observation(p, execution);
      checks.put(
          "compileStatus",
          compilationPassed(execution)
              ? "passed"
              : execution.cleanupPending() ? "unavailable" : "failed");
      if (execution.cleanupPending()) checks.put("reason", "cleanup_pending");
    }
    var proposal = w.resource(p, proposalId, "proposal");
    proposal.put("candidateRevisionId", r);
    proposal.put("checks", checks);
    proposal.put("status", checks.get("compileStatus").equals("passed") ? "ready" : "rejected");
    proposal.put("diff", candidate.changes());
    proposal.put("compileExecution", compiled);
    w.updateResource(p, proposalId, "proposal", proposal);
    return map(
        "resultKind",
        "change_proposal",
        "proposalId",
        proposalId,
        "candidateRevisionId",
        r,
        "checks",
        checks);
  }

  static boolean compilationPassed(Observation compile) {
    return compile.phase() == Phase.compile
        && compile.outcome() == ExecutionOutcome.exited
        && Integer.valueOf(0).equals(compile.exitCode())
        && !compile.truncated()
        && !compile.cleanupPending();
  }

  Map<String, Object> compile(String p, String j, String attempt, Map<String, Object> in)
      throws Exception {
    requireAvailable();
    var obs =
        runner.execute(
            p,
            j,
            attempt,
            1,
            RunnerClient.compileSpec(w.javaFiles(w.revision(p, str(in, "revisionId")))),
            () -> cancelled(p, j));
    return map(
        "resultKind",
        "compilation",
        "revisionId",
        in.get("revisionId"),
        "executionProfileId",
        "java21-v1",
        "execution",
        observation(p, obs));
  }

  Map<String, Object> run(String p, String j, String attempt, Map<String, Object> in)
      throws Exception {
    requireAvailable();
    var compile =
        runner.execute(
            p,
            j,
            attempt,
            1,
            RunnerClient.compileSpec(w.javaFiles(w.revision(p, str(in, "revisionId")))),
            () -> cancelled(p, j));
    Observation runtime = null;
    if (compilationPassed(compile) && !cancelled(p, j))
      runtime =
          runner.execute(
              p,
              j,
              attempt,
              1,
              RunnerClient.runtimeSpec(
                  compile.compileArtifactId(),
                  str(in, "entryPoint"),
                  testCase(
                      map(
                          "id",
                          "single",
                          "stdinUtf8",
                          in.getOrDefault("stdinUtf8", ""),
                          "argv",
                          in.getOrDefault("argv", List.of()))),
                  1),
              () -> cancelled(p, j));
    var report =
        map(
            "id",
            id(),
            "projectId",
            p,
            "jobId",
            j,
            "revisionId",
            in.get("revisionId"),
            "executionProfileId",
            "java21-v1",
            "entryPoint",
            in.get("entryPoint"),
            "argv",
            in.getOrDefault("argv", List.of()),
            "stdinUtf8",
            in.getOrDefault("stdinUtf8", ""),
            "availability",
            "available",
            "compileExecution",
            observation(p, compile),
            "runtimeExecution",
            runtime == null ? null : observation(p, runtime),
            "createdAt",
            java.time.Instant.now().toString());
    w.putResource(p, report.get("id").toString(), "single_run", report);
    return map("resultKind", "single_run", "reportId", report.get("id"), "report", report);
  }

  TestCase testCase(Map<String, Object> m) {
    Integer code = m.get("expectedExitCode") instanceof Number n ? n.intValue() : null;
    if (m.get("expectedExitCodes") instanceof List<?> codes) {
      if (codes.size() != 1 || !(codes.getFirst() instanceof Number n))
        throw new ApiError(422, "UNSUPPORTED_CONSTRUCT", "Only one expected exit code supported");
      code = n.intValue();
    }
    return new TestCase(
        str(m, "id"),
        Objects.toString(m.getOrDefault("stdinUtf8", "")),
        (List<String>) m.getOrDefault("argv", List.of()),
        code,
        (String) m.get("expectedStdout"),
        (String) m.get("expectedStderr"));
  }

  Map<String, Object> compare(String p, String j, String attempt, Map<String, Object> in)
      throws Exception {
    requireAvailable();
    var suite = w.resource(p, str(in, "suiteVersionId"), "suite");
    var cases =
        ((List<?>) suite.get("cases"))
            .stream().map(x -> testCase((Map<String, Object>) x)).toList();
    var comparison =
        runner.compare(
            p,
            j,
            attempt,
            1,
            w.javaFiles(w.revision(p, str(in, "baseRevisionId"))),
            w.javaFiles(w.revision(p, str(in, "candidateRevisionId"))),
            str(suite, "entryPoint"),
            cases,
            () -> cancelled(p, j));
    var results = new ArrayList<Map<String, Object>>();
    for (var t : comparison.tests())
      results.add(
          map(
              "caseId",
              t.caseId(),
              "input",
              ((List<Map<String, Object>>) suite.get("cases"))
                  .stream().filter(cs -> t.caseId().equals(cs.get("id"))).findFirst().orElseThrow(),
              "reasons",
              t.reasons(),
              "baseExecutions",
              t.baseExecutions().stream().map(o -> observation(p, o)).toList(),
              "candidateExecutions",
              t.candidateExecutions().stream().map(o -> observation(p, o)).toList(),
              "verdict",
              t.matched()
                  ? "matched"
                  : t.outcome() == ComparisonOutcome.mismatch ? "mismatch" : "inconclusive"));
    String c = id();
    var report =
        map(
            "id",
            c,
            "projectId",
            p,
            "jobId",
            j,
            "baseRevisionId",
            in.get("baseRevisionId"),
            "candidateRevisionId",
            in.get("candidateRevisionId"),
            "suiteVersionId",
            in.get("suiteVersionId"),
            "suiteVersionHash",
            suite.get("versionHash"),
            "executionProfileId",
            "java21-v1",
            "executionProfileHash",
            PROFILE_HASH,
            "outcome",
            comparison.outcome().name(),
            "matched",
            comparison.matched(),
            "total",
            comparison.total(),
            "plannedRepeatCount",
            comparison.plannedRepeatCount(),
            "observedRepeatCounts",
            map(
                "base",
                comparison.observedBaseCount(),
                "candidate",
                comparison.observedCandidateCount()),
            "coverageComplete",
            comparison.coverageComplete(),
            "inconclusiveReasons",
            comparison.reason() == null || comparison.reason().isBlank()
                ? List.of()
                : Arrays.asList(comparison.reason().split(",")),
            "assumptions",
            List.of("Exact stdout/stderr/exit under recorded Java21 profile"),
            "testResults",
            results,
            "testResultsRef",
            "/api/v1/projects/" + p + "/comparisons/" + c + "/test-results",
            "createdAt",
            java.time.Instant.now().toString());
    if (comparison.baseCompile() != null)
      report.put("baseCompile", observation(p, comparison.baseCompile()));
    if (comparison.candidateCompile() != null)
      report.put("candidateCompile", observation(p, comparison.candidateCompile()));
    w.putResource(p, c, "comparison", report);
    return map("resultKind", "comparison", "comparisonId", c, "report", report);
  }

  Map<String, Object> observation(String p, Observation o) {
    String
        stdout =
            w.artifact(p, "stdout", "text/plain; charset=utf-8", o.stdout().decode(MAX_OUTPUT)),
        stderr =
            w.artifact(p, "stderr", "text/plain; charset=utf-8", o.stderr().decode(MAX_OUTPUT));
    return map(
        "id",
        o.executionId(),
        "jobId",
        o.jobId(),
        "attemptId",
        o.attemptId(),
        "phase",
        o.phase().name(),
        "outcome",
        o.outcome().name(),
        "exitCode",
        o.exitCode(),
        "stdoutRef",
        stdout,
        "stderrRef",
        stderr,
        "stdoutUtf8",
        new String(o.stdout().decode(MAX_OUTPUT), StandardCharsets.UTF_8),
        "stderrUtf8",
        new String(o.stderr().decode(MAX_OUTPUT), StandardCharsets.UTF_8),
        "truncated",
        o.truncated(),
        "cleanupPending",
        o.cleanupPending(),
        "specHash",
        o.specHash());
  }
}
