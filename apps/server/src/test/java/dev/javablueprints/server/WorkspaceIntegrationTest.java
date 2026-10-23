package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.net.*;
import java.net.http.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"jb.runner.enabled=false", "jb.origins=http://localhost:5174"})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class WorkspaceIntegrationTest {
  static final String SCHEMA = "jbtest_" + UUID.randomUUID().toString().replace("-", "");

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbtest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  @LocalServerPort int port;
  @Autowired Workspace w;
  HttpClient http;
  String csrf;
  String origin = "http://localhost:5174";

  @BeforeEach
  void session() throws Exception {
    http =
        HttpClient.newBuilder()
            .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL))
            .build();
    var s = send("GET", "/session", null, null, null, null);
    csrf = ((Map<?, ?>) data(s)).get("csrfToken").toString();
  }

  record Reply(int status, Map<String, Object> body) {}

  Reply send(String method, String path, Object body, String key, String match, String token)
      throws Exception {
    var r =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
            .header("Origin", origin);
    if (token != null) r.header("X-CSRF-Token", token);
    if (key != null) r.header("Idempotency-Key", key);
    if (match != null) r.header("If-Match", match);
    r.header("Content-Type", "application/json")
        .method(
            method,
            body == null
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(w.encode(body)));
    var response = http.send(r.build(), HttpResponse.BodyHandlers.ofString());
    return new Reply(response.statusCode(), w.decode(response.body()));
  }

  Object data(Reply r) {
    return r.body.get("data");
  }

  Map<String, Object> obj(Reply r) {
    return (Map<String, Object>) data(r);
  }

  Reply post(String path, Object b, String key, String match) throws Exception {
    return send("POST", path, b, key, match, csrf);
  }

  String project() throws Exception {
    var r = post("/projects", map("name", "integration-" + id()), id(), null);
    assertEquals(201, r.status, r.body.toString());
    return obj(r).get("id").toString();
  }

  Map<String, Object> sources(String text) {
    return map(
        "files", List.of(map("path", "Main.java", "content", text)), "intent", "semantic_edit");
  }

  String code =
      "public class Main { public static void main(String[] args) { System.out.println(1 + 2); } }";

  @Test
  void immutableRevisionCasIdempotencyAndInvalidDraft() throws Exception {
    String p = project(), key = id();
    String path = "/projects/" + p + "/revisions";
    var body = sources("\uFEFF" + code.replace(" {", " {\r\n"));
    var first = post(path, body, key, "empty");
    assertEquals(201, first.status, first.body.toString());
    String r = obj(first).get("id").toString();
    assertEquals(first.body.get("data"), post(path, body, key, "empty").body.get("data"));
    assertEquals(409, post(path, sources(code + " "), key, "empty").status);
    assertEquals(409, post(path, sources(code), id(), "empty").status);
    assertEquals(428, post(path, sources(code), id(), null).status);
    var snapshot = w.revision(p, r);
    String canonical = w.files(snapshot).get("Main.java");
    assertFalse(canonical.contains("\r"));
    assertFalse(canonical.startsWith("\uFEFF"));
    assertThrows(
        org.springframework.dao.DataAccessException.class,
        () -> w.db.update("UPDATE revisions SET data='{}' WHERE id=?", uuid(r)));
    var invalid = post(path, sources("public class Main { invalid ???"), id(), r);
    assertEquals(201, invalid.status);
    String bad = obj(invalid).get("id").toString();
    String job =
        obj(post("/projects/" + p + "/revisions/" + bad + "/analysis", Map.of(), id(), null))
            .get("id")
            .toString();
    Map<String, Object> done = waitJob(p, job);
    assertEquals("succeeded", done.get("status"), done.toString());
    var analysis =
        obj(
            send(
                "GET",
                "/projects/" + p + "/revisions/" + bad + "/analysis",
                null,
                null,
                null,
                null));
    assertEquals("invalid", analysis.get("parseStatus"));
    assertEquals(
        409,
        send(
                "GET",
                "/projects/" + p + "/revisions/" + bad + "/graph?analysisId=" + analysis.get("id"),
                null,
                null,
                null,
                null)
            .status);
  }

  @Test
  void securityScopeUnavailableAndExport() throws Exception {
    String p = project();
    var save = post("/projects/" + p + "/revisions", sources(code), id(), "empty");
    String r = obj(save).get("id").toString();
    assertEquals(403, send("POST", "/projects", map("name", "bad"), id(), null, null).status);
    String prior = origin;
    origin = "https://evil.example";
    assertEquals(403, post("/projects", map("name", "bad"), id(), null).status);
    origin = prior;
    String other = project();
    assertEquals(
        404, send("GET", "/projects/" + other + "/revisions/" + r, null, null, null, null).status);
    assertEquals(
        503,
        post(
                "/projects/" + p + "/runs",
                map(
                    "revisionId",
                    r,
                    "entryPoint",
                    "Main",
                    "argv",
                    List.of(),
                    "stdinUtf8",
                    "",
                    "profileId",
                    "java21-v1"),
                id(),
                null)
            .status);
    assertEquals(
        400,
        post(
                "/projects/" + p + "/revisions",
                map("files", List.of(map("path", "../Escape.java", "content", code))),
                id(),
                r)
            .status);
    assertEquals(400, post("/projects", map("name", "bad", "unexpected", true), id(), null).status);
    var export =
        post(
            "/projects/" + p + "/exports",
            map("revisionId", r, "includeReportIds", List.of()),
            id(),
            null);
    assertEquals(201, export.status, export.body.toString());
    String a = obj(export).get("artifactId").toString();
    assertEquals(
        404, send("GET", "/projects/" + other + "/artifacts/" + a, null, null, null, null).status);
  }

  @Test
  void jobFinalityAndAnalysisBindings() throws Exception {
    String p = project();
    String r =
        obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty"))
            .get("id")
            .toString();
    var job = post("/projects/" + p + "/revisions/" + r + "/analysis", Map.of(), id(), null);
    String j = obj(job).get("id").toString();
    var done = waitJob(p, j);
    assertEquals("succeeded", done.get("status"));
    String attempt = done.get("attemptId").toString();
    assertEquals(
        0,
        w.db.update(
            "UPDATE jobs SET status='failed' WHERE id=? AND attempt_id=? AND status='running'",
            uuid(j),
            uuid(attempt)));
    String r2 =
        obj(post("/projects/" + p + "/revisions", sources(code + " "), id(), r))
            .get("id")
            .toString();
    var analysis =
        obj(
            send(
                "GET", "/projects/" + p + "/revisions/" + r + "/analysis", null, null, null, null));
    assertEquals(
        409,
        send(
                "GET",
                "/projects/"
                    + p
                    + "/revisions/"
                    + r2
                    + "/analysis?analysisId="
                    + analysis.get("id"),
                null,
                null,
                null,
                null)
            .status);
    assertEquals("java21-v1", w.revision(p, r).get("languageProfileId"));
  }

  @Test
  void concurrentCasAndRawRoundtrip() throws Exception {
    String p = project();
    String initial =
        obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty"))
            .get("id")
            .toString();
    var gate = new java.util.concurrent.CountDownLatch(1);
    var pool = java.util.concurrent.Executors.newFixedThreadPool(2);
    try {
      var a =
          pool.submit(
              () -> {
                gate.await();
                return post(
                        "/projects/" + p + "/revisions", sources(code + " // one"), id(), initial)
                    .status();
              });
      var b =
          pool.submit(
              () -> {
                gate.await();
                return post(
                        "/projects/" + p + "/revisions", sources(code + " // two"), id(), initial)
                    .status();
              });
      gate.countDown();
      assertEquals(Set.of(201, 409), Set.of(a.get(), b.get()));
      assertEquals(2, w.revisions(p, 100).size());
    } finally {
      pool.shutdownNow();
    }
    String imported = project(), boundary = "test" + id();
    byte[] raw =
        ("\uFEFF" + code.replace("println(1 + 2)", "println(\"Привет\")") + "\r\n")
            .getBytes(java.nio.charset.StandardCharsets.UTF_8);
    var body = new java.io.ByteArrayOutputStream();
    body.write(
        ("--"
                + boundary
                + "\r\n"
                + "Content-Disposition: form-data; name=\"files\"; filename=\"Main.java\"\r\n"
                + "Content-Type: text/plain\r\n\r\n")
            .getBytes());
    body.write(raw);
    body.write(("\r\n--" + boundary + "--\r\n").getBytes());
    var request =
        HttpRequest.newBuilder(
                URI.create(
                    "http://127.0.0.1:" + port + "/api/v1/projects/" + imported + "/imports"))
            .header("Origin", origin)
            .header("X-CSRF-Token", csrf)
            .header("Idempotency-Key", id())
            .header("If-Match", "empty")
            .header("Content-Type", "multipart/form-data; boundary=" + boundary)
            .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()))
            .build();
    var response = http.send(request, HttpResponse.BodyHandlers.ofString());
    assertEquals(201, response.statusCode(), response.body());
    var rev = (Map<String, Object>) w.decode(response.body()).get("data");
    var f = (Map<String, Object>) ((List<?>) rev.get("files")).getFirst();
    var original =
        http.send(
            HttpRequest.newBuilder(
                    URI.create(
                        "http://127.0.0.1:"
                            + port
                            + "/api/v1/projects/"
                            + imported
                            + "/artifacts/"
                            + f.get("rawArtifactRef")))
                .GET()
                .build(),
            HttpResponse.BodyHandlers.ofByteArray());
    assertArrayEquals(raw, original.body());
    var exported =
        obj(
            post(
                "/projects/" + imported + "/exports",
                map("revisionId", rev.get("id"), "includeReportIds", List.of()),
                id(),
                null));
    var zipResponse =
        http.send(
            HttpRequest.newBuilder(
                    URI.create("http://127.0.0.1:" + port + exported.get("downloadUrl")))
                .GET()
                .build(),
            HttpResponse.BodyHandlers.ofByteArray());
    try (var zip =
        new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(zipResponse.body()))) {
      assertEquals("Main.java", zip.getNextEntry().getName());
      assertEquals(
          f.get("canonicalText"),
          new String(zip.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
      assertNull(zip.getNextEntry());
    }
  }

  @Autowired JobWorker worker;

  @Test
  void staleAndCancelledAttemptsCannotPublish() throws Exception {
    String p = project(), j = id(), active = id(), stale = id(), resource = id();
    w.db.update(
        "INSERT INTO"
            + " jobs(id,project_id,type,status,input,attempt_id,lease_until,started_at)VALUES(?,?,'run','running','{}',?,now()+interval"
            + " '1 minute',now())",
        uuid(j),
        uuid(p),
        uuid(active));
    w.publication.set(new ArrayList<>());
    w.putResource(p, resource, "comparison", map("outcome", "matched_on_tests"));
    worker.finish(p, j, stale, map("fake", true), null);
    assertThrows(ApiError.class, () -> w.resource(p, resource, "comparison"));
    assertEquals("running", w.job(p, j).get("status"));
    w.db.update("UPDATE jobs SET cancel_requested_at=now() WHERE id=?", uuid(j));
    w.publication.set(new ArrayList<>());
    w.putResource(p, resource, "comparison", map("outcome", "matched_on_tests"));
    worker.finish(p, j, active, map("fake", true), null);
    assertThrows(ApiError.class, () -> w.resource(p, resource, "comparison"));
    assertEquals("cancelled", w.job(p, j).get("status"));
    w.publication.remove();
  }

  @Test
  void exactGraphAndLayoutBindings() throws Exception {
    String p = project(),
        r =
            obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty"))
                .get("id")
                .toString();
    String j =
        obj(post("/projects/" + p + "/revisions/" + r + "/analysis", Map.of(), id(), null))
            .get("id")
            .toString();
    assertEquals("succeeded", waitJob(p, j).get("status"));
    var a =
        obj(
            send(
                "GET", "/projects/" + p + "/revisions/" + r + "/analysis", null, null, null, null));
    var graph = (Map<String, Object>) a.get("graph");
    String method = ((Map<?, ?>) ((List<?>) graph.get("methods")).getFirst()).get("id").toString();
    String node = ((Map<?, ?>) ((List<?>) graph.get("nodes")).getFirst()).get("id").toString();
    assertEquals(
        409,
        send(
                "GET",
                "/projects/"
                    + p
                    + "/revisions/"
                    + r
                    + "/graph?analysisId="
                    + a.get("id")
                    + "&methodId=alien",
                null,
                null,
                null,
                null)
            .status);
    var layout =
        map(
            "analysisId",
            a.get("id"),
            "sourceMapVersion",
            a.get("sourceMapVersion"),
            "methodId",
            method,
            "layoutVersion",
            0,
            "positions",
            List.of(map("nodeId", "alien", "x", 0, "y", 0)),
            "collapsedNodeIds",
            List.of(),
            "viewport",
            map("x", 0, "y", 0, "zoom", 1));
    String path = "/projects/" + p + "/revisions/" + r + "/layout";
    assertEquals(409, send("PUT", path, layout, null, null, csrf).status);
    layout.put("positions", List.of(map("nodeId", node, "x", 0, "y", 0)));
    assertEquals(200, send("PUT", path, layout, null, null, csrf).status);
    assertEquals(409, send("PUT", path, layout, null, null, csrf).status);
  }

  @Test
  void defaultAnalysisRejectsPreviousAnalyzerVersion() throws Exception {
    String p = project();
    String r =
        obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty"))
            .get("id")
            .toString();
    String old = id();
    w.putResource(
        p,
        old,
        "analysis",
        map(
            "id",
            old,
            "revisionId",
            r,
            "analyzerVersion",
            "engine-old",
            "sourceMapVersion",
            "utf16-token-v1",
            "parseStatus",
            "valid"));
    assertEquals(
        404,
        send("GET", "/projects/" + p + "/revisions/" + r + "/analysis", null, null, null, null)
            .status);
    assertEquals(
        200,
        send(
                "GET",
                "/projects/" + p + "/revisions/" + r + "/analysis?analysisId=" + old,
                null,
                null,
                null,
                null)
            .status);
    String j =
        obj(post("/projects/" + p + "/revisions/" + r + "/analysis", Map.of(), id(), null))
            .get("id")
            .toString();
    assertEquals("succeeded", waitJob(p, j).get("status"));
    assertEquals(
        dev.javablueprints.engine.ProgramEngine.VERSION,
        obj(send("GET", "/projects/" + p + "/revisions/" + r + "/analysis", null, null, null, null))
            .get("analyzerVersion"));
  }

  @Test
  void runnerIngressRejectsInvalidIdentifiersArgumentsAndPathsBeforeQueueing() throws Exception {
    String p = project();
    String path = "/projects/" + p + "/test-suites";
    for (String caseId : List.of("case 1", "вход1")) {
      var suite =
          map(
              "mode",
              "console",
              "entryPoint",
              "Main",
              "comparisonPolicyId",
              "exact-v1",
              "cases",
              List.of(map("id", caseId, "stdinUtf8", "", "argv", List.of())));
      assertEquals(400, post(path, suite, id(), null).status);
    }
    for (List<String> args :
        List.of(List.of("bad\u0000arg"), Collections.nCopies(9, "я".repeat(4000)))) {
      var suite =
          map(
              "mode",
              "console",
              "entryPoint",
              "Main",
              "comparisonPolicyId",
              "exact-v1",
              "cases",
              List.of(map("id", "valid-id", "stdinUtf8", "", "argv", args)));
      assertEquals(400, post(path, suite, id(), null).status);
    }
    assertEquals(
        400,
        post(
                "/projects/" + p + "/revisions",
                map("files", List.of(map("path", "foo-bar.java", "content", code))),
                id(),
                "empty")
            .status);
    assertEquals(
        0,
        w.db.queryForObject(
            "SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
  }

  @Test
  void expiredLeaseFinalizesAttemptAndRejectsProposal() {
    String p = w.createProject("lease-regression").get("id").toString(),
        j = id(),
        attempt = id(),
        proposal = id();
    w.db.update(
        "INSERT INTO"
            + " jobs(id,project_id,type,status,input,attempt_id,lease_until,started_at)VALUES(?,?,'change','running','{}',?,now()-interval"
            + " '1 second',now()-interval '1 minute')",
        uuid(j),
        uuid(p),
        uuid(attempt));
    w.db.update(
        "INSERT INTO job_attempts(id,job_id,status)VALUES(?,?,'running')", uuid(attempt), uuid(j));
    w.putResource(p, proposal, "proposal", map("id", proposal, "jobId", j, "status", "queued"));
    worker.expireLeases();
    assertEquals("failed", w.job(p, j).get("status"));
    assertEquals(
        "failed",
        w.db.queryForObject(
            "SELECT status FROM job_attempts WHERE id=?", String.class, uuid(attempt)));
    assertEquals("rejected", w.resource(p, proposal, "proposal").get("status"));
  }

  @Test
  void pendingCompilerCleanupRejectsProposalAndPreventsRuntimeSubmission() throws Exception {
    var submissions = new java.util.concurrent.atomic.AtomicInteger();
    var stub =
        com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
    stub.createContext(
        "/internal/v1/health",
        exchange -> {
          byte[] bytes =
              dev.javablueprints.verification.RunnerProtocol.JSON.writeValueAsBytes(
                  Map.of("available", true, "origin", "test_stub"));
          exchange.sendResponseHeaders(200, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    stub.createContext(
        "/internal/v1/executions",
        exchange -> {
          submissions.incrementAndGet();
          var protocol = dev.javablueprints.verification.RunnerProtocol.JSON;
          var request =
              protocol.readValue(
                  exchange.getRequestBody(),
                  dev.javablueprints.verification.RunnerProtocol.Submit.class);
          var observation =
              new dev.javablueprints.verification.RunnerProtocol.Observation(
                  request.projectId(),
                  request.jobId(),
                  request.attemptId(),
                  request.executionId(),
                  request.specHash(),
                  dev.javablueprints.verification.RunnerProtocol.Phase.compile,
                  "terminal",
                  dev.javablueprints.verification.RunnerProtocol.ExecutionOutcome.exited,
                  0,
                  dev.javablueprints.verification.RunnerProtocol.Bytes.text(""),
                  dev.javablueprints.verification.RunnerProtocol.Bytes.text(""),
                  false,
                  "test-artifact",
                  true);
          byte[] bytes = protocol.writeValueAsBytes(observation);
          exchange.sendResponseHeaders(202, bytes.length);
          exchange.getResponseBody().write(bytes);
          exchange.close();
        });
    stub.start();
    try {
      String p = project();
      String revision =
          obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty"))
              .get("id")
              .toString();
      var engine = new dev.javablueprints.engine.ProgramEngine();
      var analysis =
          engine.inspect(
              new dev.javablueprints.engine.EngineModel.SourceBundle(
                  revision, w.files(w.revision(p, revision))));
      w.putResource(p, analysis.id(), "analysis", analysis);
      var node =
          analysis.graph().nodes().stream()
              .filter(n -> n.kind().equals("expression") && n.label().equals("2"))
              .findFirst()
              .orElseThrow();
      String proposal = id(), j = id(), attempt = id();
      w.putResource(
          p,
          proposal,
          "proposal",
          map("id", proposal, "jobId", j, "status", "queued", "baseRevisionId", revision));
      var fixtureWorker =
          new JobWorker(w, true, "http://127.0.0.1:" + stub.getAddress().getPort(), "test_stub");
      fixtureWorker.change(
          p,
          j,
          attempt,
          map(
              "proposalId",
              proposal,
              "baseRevisionId",
              revision,
              "analysisId",
              analysis.id(),
              "methodId",
              node.methodId(),
              "nodeId",
              node.id(),
              "operation",
              "replace_expression",
              "payload",
              map("field", "expression", "source", "3"),
              "intent",
              "semantic_edit"));
      var rejected = w.resource(p, proposal, "proposal");
      assertEquals("rejected", rejected.get("status"));
      assertEquals("cleanup_pending", ((Map<?, ?>) rejected.get("checks")).get("reason"));
      var result =
          fixtureWorker.run(
              p,
              id(),
              id(),
              map(
                  "revisionId",
                  revision,
                  "entryPoint",
                  "Main",
                  "stdinUtf8",
                  "",
                  "argv",
                  List.of()));
      assertNull(((Map<?, ?>) result.get("report")).get("runtimeExecution"));
      assertEquals(
          2,
          submissions.get(),
          "One compile for proposal and one compile for single run; no runtime execution");
    } finally {
      stub.stop(0);
    }
  }

  Map<String, Object> waitJob(String p, String j) throws Exception {
    long end = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    while (System.nanoTime() < end) {
      var job = obj(send("GET", "/projects/" + p + "/jobs/" + j, null, null, null, null));
      if (Set.of("succeeded", "failed", "cancelled").contains(job.get("status"))) return job;
      Thread.sleep(100);
    }
    throw new AssertionError("Job deadline");
  }
}
