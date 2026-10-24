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
  void restoreCreatesFreshUnverifiedRevisionWithScopedSourceAndIdempotentCas() throws Exception {
    String p = project(), path = "/projects/" + p + "/revisions";
    var original = obj(post(path, sources(code), id(), "empty"));
    String first = str(original, "id");
    var bad = obj(post(path, sources("public class Main { broken ???"), id(), first));
    String invalid = str(bad, "id");
    String restorePath = path + "/" + first + "/restore", key = id();
    var body = map("expectedHeadRevisionId", invalid);
    assertEquals(400, post(restorePath, Map.of(), id(), invalid).status);
    assertEquals(400, post(restorePath, map("expectedHeadRevisionId", invalid, "files", List.of()), id(), invalid).status);
    assertEquals(400, post(restorePath, map("expectedHeadRevisionId", first), id(), invalid).status);
    assertEquals(428, post(restorePath, body, id(), null).status);
    assertEquals(404, post(path + "/" + id() + "/restore", body, id(), invalid).status);
    String other = project();
    String foreign = str(obj(post("/projects/" + other + "/revisions", sources(code), id(), "empty")), "id");
    assertEquals(404, post(path + "/" + foreign + "/restore", body, id(), invalid).status);
    var reply = post(restorePath, body, key, invalid);
    assertEquals(201, reply.status, reply.body.toString());
    var restored = obj(reply);
    String current = str(restored, "id");
    assertNotEquals(first, current);
    assertEquals(invalid, restored.get("parentRevisionId"));
    assertEquals(first, restored.get("sourceRevisionId"));
    assertEquals("restore", restored.get("kind"));
    assertEquals("restore", restored.get("origin"));
    assertEquals("semantic_edit", restored.get("intent"));
    assertEquals("unverified", restored.get("verificationStatus"));
    assertEquals(original.get("bundleHash"), restored.get("bundleHash"));
    assertEquals(original.get("files"), restored.get("files"));
    assertEquals(original, w.revision(p, first));
    assertEquals(first, w.project(p).get("originalRevisionId"));
    assertEquals(restored, obj(post(restorePath, body, key, invalid)));
    assertEquals(409, post(restorePath, map("expectedHeadRevisionId", current), key, current).status);
    assertEquals(409, post(restorePath, body, id(), invalid).status);
    var persisted = w.revision(p, current);
    assertEquals(first, persisted.get("sourceRevisionId"));
    assertFalse(persisted.containsKey("analysisId"));
    assertFalse(persisted.containsKey("verificationReportId"));
    assertEquals(1, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=? AND input->>'revisionId'=?", Integer.class, uuid(p), current));
    String job = str((Map<String, Object>) restored.get("analysisJob"), "id");
    assertEquals("succeeded", waitJob(p, job).get("status"));
    assertEquals("valid", w.analysis(p, current, null).get("parseStatus"));
    // Restoring an invalid historical draft is valid source-history work, not a verified candidate.
    var invalidReply = post(path + "/" + invalid + "/restore", map("expectedHeadRevisionId", current), id(), current);
    assertEquals(201, invalidReply.status, invalidReply.body.toString());
    var invalidRestored = obj(invalidReply);
    assertEquals("unverified", invalidRestored.get("verificationStatus"));
    assertEquals(bad.get("files"), invalidRestored.get("files"));
    assertEquals("succeeded", waitJob(p, str((Map<String, Object>) invalidRestored.get("analysisJob"), "id")).get("status"));
    assertEquals("invalid", w.analysis(p, str(invalidRestored, "id"), null).get("parseStatus"));
  }

  @Test
  void malformedGraphPayloadsAreRejectedBeforeQueueing() throws Exception {
    String p = project();
    var base = map("baseRevisionId", id(), "analysisId", id(), "methodId", "method", "nodeId", "node", "intent", "semantic_edit");
    var invalid = List.of(
        map("operation", "insert_statement", "payload", map("position", "sideways", "source", "x++;")),
        map("operation", "insert_statement", "payload", map("position", "before", "source", 12)),
        map("operation", "insert_statement", "payload", map("position", "before", "source", " ")),
        map("operation", "insert_statement", "payload", map("position", "before", "source", "x++;", "extra", true)),
        map("operation", "delete_statement", "payload", map("source", "x++;")),
        map("operation", "delete_statement", "payload", List.of()),
        map("operation", "replace_expression", "payload", map("field", "body", "source", "x")),
        map("operation", "wrap", "payload", Map.of()));
    for (var edit : invalid) {
      var command = new LinkedHashMap<>(base);
      command.putAll(edit);
      var reply = post("/projects/" + p + "/changes", command, id(), null);
      assertEquals(400, reply.status, reply.body.toString());
    }
    assertEquals(0, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
    assertEquals(0, w.db.queryForObject("SELECT count(*) FROM resources WHERE project_id=?", Integer.class, uuid(p)));
  }

  @Test
  void structuralCommandsCreateDetachedCandidatesAndRetainCompileGate() throws Exception {
    String p = project();
    String originalCode = "public class Main { public static void main(String[] args) { System.out.println(1); } }";
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(originalCode), id(), "empty")), "id");
    var engine = new dev.javablueprints.engine.ProgramEngine();
    var analysis = engine.inspect(new dev.javablueprints.engine.EngineModel.SourceBundle(revision, w.files(w.revision(p, revision))));
    w.putResource(p, analysis.id(), "analysis", analysis);
    var node = analysis.graph().nodes().stream().filter(n -> n.allowedOperations().contains("delete_statement")).findFirst().orElseThrow();
    for (String operation : List.of("insert_statement", "delete_statement")) {
      var payload = operation.equals("insert_statement") ? map("position", "before", "source", "System.out.println(2);") : Map.<String, Object>of();
      var body = map("baseRevisionId", revision, "analysisId", analysis.id(), "methodId", node.methodId(), "nodeId", node.id(), "operation", operation, "payload", payload, "intent", "semantic_edit");
      var submitted = post("/projects/" + p + "/changes", body, id(), null);
      assertEquals(202, submitted.status, submitted.body.toString());
      assertEquals("succeeded", waitJob(p, str(obj(submitted), "jobId")).get("status"));
      var proposal = w.resource(p, str(obj(submitted), "id"), "proposal");
      assertEquals("rejected", proposal.get("status"), "Disabled runner cannot authorize apply");
      assertEquals("unavailable", ((Map<?, ?>) proposal.get("checks")).get("compileStatus"));
      assertEquals("valid", ((Map<?, ?>) proposal.get("checks")).get("parseStatus"));
      String candidateId = str(proposal, "candidateRevisionId");
      assertNotEquals(revision, candidateId);
      String changed = w.files(w.revision(p, candidateId)).get("Main.java");
      if (operation.equals("insert_statement")) assertTrue(changed.contains("System.out.println(2);"));
      else assertFalse(changed.contains("System.out.println(1);"));
      assertFalse(((List<?>) proposal.get("diff")).isEmpty());
      assertEquals(revision, w.project(p).get("headRevisionId"));
      assertEquals(409, post("/projects/" + p + "/head", map("expectedHeadRevisionId", revision, "candidateRevisionId", candidateId, "proposalId", proposal.get("id")), id(), revision).status);
    }
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
    String importedId = str(rev, "id");
    String later = str(obj(post("/projects/" + imported + "/revisions", sources(code), id(), importedId)), "id");
    var restoredReply = post("/projects/" + imported + "/revisions/" + importedId + "/restore",
        map("expectedHeadRevisionId", later), id(), later);
    assertEquals(201, restoredReply.status, restoredReply.body.toString());
    var restored = obj(restoredReply);
    assertEquals(rev.get("files"), restored.get("files"), "Raw refs, hashes and normalization metadata survive restore");
    assertEquals(rev.get("bundleHash"), restored.get("bundleHash"));
    assertEquals(importedId, w.project(imported).get("originalRevisionId"));
    var restoredFile = (Map<?, ?>) ((List<?>) w.revision(imported, str(restored, "id")).get("files")).getFirst();
    assertArrayEquals(raw, w.db.queryForObject("SELECT bytes FROM artifacts WHERE project_id=? AND id=?", byte[].class, uuid(imported), uuid(restoredFile.get("rawArtifactRef").toString())));
    assertTrue(w.revisions(imported, 100).stream().anyMatch(r -> importedId.equals(r.get("sourceRevisionId"))));
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

  Map<String, Object> analyzeRevision(String p, String revision) throws Exception {
    var queued = post("/projects/" + p + "/revisions/" + revision + "/analysis", Map.of(), id(), null);
    assertEquals(202, queued.status, queued.body.toString());
    assertEquals("succeeded", waitJob(p, str(obj(queued), "id")).get("status"));
    var reply = send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis", null, null, null, null);
    assertEquals(200, reply.status, reply.body.toString());
    return obj(reply);
  }

  @Test
  void semanticModelSurvivesDatabaseAndHttpWithAnalysisScopedBindings() throws Exception {
    String p = project();
    String main = "// 😀\npackage sample; public class Main { int value=1; int parameter(int value){return this.value + value;} int local(){int value=3;return value;} int call(){return Util.twice(value);} public static void main(String[] args){System.out.println(new Main().call());}}";
    String util = "package sample; public class Util {public static int twice(int input){return input*2;}}";
    var texts = Map.of("sample/Main.java", main, "sample/Util.java", util);
    var save = post("/projects/" + p + "/revisions", map("files", texts.entrySet().stream().map(e -> map("path", e.getKey(), "content", e.getValue())).toList(), "intent", "semantic_edit"), id(), "empty");
    assertEquals(201, save.status, save.body.toString());
    String revision = str(obj(save), "id");
    var a = analyzeRevision(p, revision);
    assertEquals(dev.javablueprints.engine.ProgramEngine.currentSymbolEnvironmentHash(), a.get("symbolEnvironmentHash"));
    var model = (Map<String, Object>) a.get("semantics");
    assertEquals(a.get("symbolEnvironmentHash"), ((Map<?, ?>) model.get("environment")).get("environmentHash"));
    var symbols = (List<Map<String, Object>>) model.get("symbols");
    var references = (List<Map<String, Object>>) model.get("references");
    assertFalse(symbols.isEmpty());
    assertFalse(references.isEmpty());
    var ids = new HashSet<String>();
    symbols.forEach(s -> assertTrue(ids.add(str(s, "id")), "Distinct symbol IDs"));
    var referenceIds = new HashSet<String>();
    for (var symbol : symbols) {
      var range = (Map<String, Object>) symbol.get("sourceRange");
      if (Boolean.TRUE.equals(symbol.get("external"))) {
        assertNull(range);
        assertNotNull(symbol.get("externalKey"));
      } else {
        assertNotNull(range);
        String text = texts.get(str(range, "filePath"));
        assertNotNull(text);
        String slice = text.substring(((Number) range.get("startOffset")).intValue(), ((Number) range.get("endOffset")).intValue());
        assertTrue(slice.contains(str(symbol, "name")), symbol.toString());
      }
    }
    var values = symbols.stream().filter(s -> "value".equals(s.get("name")) && !Boolean.TRUE.equals(s.get("external"))).toList();
    assertEquals(3, values.size(), values.toString());
    assertEquals(3, values.stream().map(s -> s.get("id")).distinct().count());
    for (var ref : references) {
      assertTrue(referenceIds.add(str(ref, "id")), "Distinct reference IDs");
      assertTrue(ids.containsAll((List<String>) ref.get("targetIds")), "Every target belongs to this semantic model");
      if (ref.get("enclosingCallableId") != null)
        assertTrue(ids.contains(ref.get("enclosingCallableId")), "Callable belongs to this semantic model");
      assertTrue(((List<?>) ref.get("runtimeTargetIds")).isEmpty(), "No closed runtime dispatch claim");
      var range = (Map<String, Object>) ref.get("sourceRange");
      assertNotNull(texts.get(str(range, "filePath")));
      assertTrue(((Number) range.get("endOffset")).intValue() > ((Number) range.get("startOffset")).intValue());
    }
    // this.field and the parameter/local return occurrences must bind to separate declarations.
    var targets = new HashSet<Object>();
    for (int offset : List.of(main.indexOf("this.value") + 5, main.indexOf("+ value") + 2, main.indexOf("return value") + 7)) {
      var ref = references.stream().filter(r -> {
        var range = (Map<?, ?>) r.get("sourceRange");
        return "sample/Main.java".equals(range.get("filePath"))
            && ((Number) range.get("startOffset")).intValue() <= offset
            && ((Number) range.get("endOffset")).intValue() > offset
            && "value".equals(r.get("name"));
      }).findFirst().orElseThrow();
      assertEquals("exact", ref.get("resolution"), ref.toString());
      assertEquals(1, ((List<?>) ref.get("targetIds")).size());
      targets.add(((List<?>) ref.get("targetIds")).getFirst());
    }
    assertEquals(3, targets.size());
    assertTrue(references.stream().anyMatch(r -> "twice".equals(r.get("name")) && "exact".equals(r.get("resolution"))));
    String aid = str(a, "id");
    assertEquals(a, w.resource(p, aid, "analysis"));
    assertEquals(a, obj(send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis?analysisId=" + aid, null, null, null, null)));
    var mapped = w.convert(a, dev.javablueprints.engine.EngineModel.Analysis.class);
    assertEquals(model, w.decode(w.encode(mapped.semantics())));
    var next = analyzeRevision(p, revision);
    assertNotEquals(aid, next.get("id"));
    var nextSymbols = (List<Map<String, Object>>) ((Map<?, ?>) next.get("semantics")).get("symbols");
    assertTrue(nextSymbols.stream().noneMatch(s -> ids.contains(s.get("id"))), "Bindings are analysis scoped");
    String foreign = project();
    String foreignRevision = str(obj(post("/projects/" + foreign + "/revisions", sources(code), id(), "empty")), "id");
    assertEquals(404, send("GET", "/projects/" + foreign + "/revisions/" + foreignRevision + "/analysis?analysisId=" + aid, null, null, null, null).status);
  }

  List<String> normalConditionTrace(dev.javablueprints.engine.EngineModel.Graph graph, String methodName,
      Map<String, Boolean> atomValues) {
    var method = graph.methods().stream().filter(m -> m.fullyQualifiedName().endsWith("." + methodName)).findFirst().orElseThrow();
    var nodes = graph.nodes().stream().collect(java.util.stream.Collectors.toMap(dev.javablueprints.engine.EngineModel.GraphNode::id, n -> n));
    var trace = new ArrayList<String>();
    String current = method.entryNodeId();
    for (int step = 0; step < 40; step++) {
      var node = nodes.get(current);
      assertNotNull(node);
      assertEquals(method.id(), node.methodId());
      assertNotEquals("ast_projection", node.executionRole(), "Source projection cannot run as a second instruction");
      if (node.kind().equals("normal_exit")) return trace;
      if (node.executionRole().equals("condition_test") || node.executionRole().equals("statement")) trace.add(node.label());
      String from = current;
      var outgoing = graph.edges().stream().filter(e -> e.source().equals(from)).toList();
      if (node.executionRole().equals("condition_test")) {
        assertTrue(atomValues.containsKey(node.label()), "Every visited atom has an independent fixture value");
        String branch = atomValues.get(node.label()) ? "true" : "false";
        current = outgoing.stream().filter(e -> e.kind().equals(branch)).findFirst().orElseThrow().target();
      } else {
        assertEquals(1, outgoing.size(), "Non-test anchor/statement has one normal continuation in this fixture");
        current = outgoing.getFirst().target();
      }
    }
    throw new AssertionError("Normal trace did not terminate");
  }

  @Test
  void shortCircuitGraphRoundTripsAndConditionCandidateRegeneratesItsOwnPaths() throws Exception {
    String p = project();
    String source = "// 😀\nclass Main {int decide(boolean left, boolean right){if(left && right)return 1;return 0;}}";
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(source), id(), "empty")), "id");
    var a = analyzeRevision(p, revision);
    var original = w.convert(a, dev.javablueprints.engine.EngineModel.Analysis.class);
    var graphReply = send("GET", "/projects/" + p + "/revisions/" + revision + "/graph?analysisId=" + original.id(), null, null, null, null);
    assertEquals(200, graphReply.status, graphReply.body.toString());
    var graph = w.convert(obj(graphReply), dev.javablueprints.engine.EngineModel.Graph.class);
    assertEquals(original.graph(), graph, "Graph role/range/ID data survives immutable persistence and HTTP");
    assertEquals(List.of("left", "return 0;"), normalConditionTrace(graph, "decide", Map.of("left", false)));
    assertEquals(List.of("left", "right", "return 0;"), normalConditionTrace(graph, "decide", Map.of("left", true, "right", false)));
    assertEquals(List.of("left", "right", "return 1;"), normalConditionTrace(graph, "decide", Map.of("left", true, "right", true)));
    for (var atom : graph.nodes().stream().filter(n -> n.kind().equals("condition_test")).toList()) {
      assertEquals("condition_test", atom.executionRole());
      assertTrue(atom.editableFields().isEmpty());
      assertTrue(atom.allowedOperations().isEmpty());
      assertEquals(atom.label(), source.substring(atom.sourceRange().startOffset(), atom.sourceRange().endOffset()));
    }
    var header = graph.nodes().stream().filter(n -> n.kind().equals("IfStmt")).findFirst().orElseThrow();
    assertEquals("structural", header.executionRole());
    assertTrue(header.allowedOperations().contains("replace_expression"));
    var body = map("baseRevisionId", revision, "analysisId", original.id(), "methodId", header.methodId(), "nodeId", header.id(), "operation", "replace_expression", "payload", map("field", "condition", "source", "left || right"), "intent", "semantic_edit");
    var submitted = post("/projects/" + p + "/changes", body, id(), null);
    assertEquals(202, submitted.status, submitted.body.toString());
    assertEquals("succeeded", waitJob(p, str(obj(submitted), "jobId")).get("status"));
    var proposal = w.resource(p, str(obj(submitted), "id"), "proposal");
    assertEquals("rejected", proposal.get("status"));
    assertEquals("unavailable", ((Map<?, ?>) proposal.get("checks")).get("compileStatus"));
    String candidate = str(proposal, "candidateRevisionId");
    var candidateAnalysis = w.convert(analyzeRevision(p, candidate), dev.javablueprints.engine.EngineModel.Analysis.class);
    assertEquals(List.of("left", "return 1;"), normalConditionTrace(candidateAnalysis.graph(), "decide", Map.of("left", true)));
    assertEquals(List.of("left", "right", "return 1;"), normalConditionTrace(candidateAnalysis.graph(), "decide", Map.of("left", false, "right", true)));
    assertEquals(List.of("left", "right", "return 0;"), normalConditionTrace(candidateAnalysis.graph(), "decide", Map.of("left", false, "right", false)));
    assertEquals(revision, w.project(p).get("headRevisionId"));
    assertEquals(source, w.files(w.revision(p, revision)).get("Main.java"));
    assertEquals(graph, w.convert(w.analysis(p, revision, original.id()).get("graph"), dev.javablueprints.engine.EngineModel.Graph.class));
    var originalIds = graph.nodes().stream().map(dev.javablueprints.engine.EngineModel.GraphNode::id).collect(java.util.stream.Collectors.toSet());
    assertTrue(candidateAnalysis.graph().nodes().stream().noneMatch(n -> originalIds.contains(n.id())), "Candidate graph has its own bindings");
    assertEquals(409, post("/projects/" + p + "/head", map("expectedHeadRevisionId", revision, "candidateRevisionId", candidate, "proposalId", proposal.get("id")), id(), revision).status);
    var capabilities = obj(send("GET", "/capabilities", null, null, null, null));
    assertEquals("partial", ((Map<?, ?>) capabilities.get("condition_flow")).get("status"));
    assertEquals("normal_short_circuit_conditions", ((Map<?, ?>) capabilities.get("condition_flow")).get("scope"));
    assertEquals("partial", ((Map<?, ?>) capabilities.get("control_flow")).get("status"));
    assertEquals("unknown", ((Map<?, ?>) capabilities.get("control_flow")).get("exceptionalFlow"));
  }

  @Test
  void legacyGraphExecutionRoleIsUnknownAndOldEngineCannotAuthorizeCurrentEdits() throws Exception {
    String p = project();
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty")), "id");
    var old = w.decode(w.encode(new dev.javablueprints.engine.ProgramEngine().inspect(new dev.javablueprints.engine.EngineModel.SourceBundle(revision, w.files(w.revision(p, revision))))));
    old.put("analyzerVersion", "engine-0.3.0");
    var graph = (Map<String, Object>) old.get("graph");
    ((List<Map<String, Object>>) graph.get("nodes")).forEach(n -> n.remove("executionRole"));
    String aid = str(old, "id");
    w.putResource(p, aid, "analysis", old);
    var explicit = send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis?analysisId=" + aid, null, null, null, null);
    assertEquals(200, explicit.status);
    assertEquals(old, obj(explicit));
    var mapped = w.convert(obj(explicit), dev.javablueprints.engine.EngineModel.Analysis.class);
    assertTrue(mapped.graph().nodes().stream().allMatch(n -> n.executionRole() == null), "Absent legacy role must not become executable");
    assertEquals(404, send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis", null, null, null, null).status);
    var edit = map("baseRevisionId", revision, "analysisId", aid, "methodId", "m", "nodeId", "n", "operation", "replace_expression", "payload", map("field", "expression", "source", "2"), "intent", "semantic_edit");
    assertEquals(409, post("/projects/" + p + "/changes", edit, id(), null).status);
    assertEquals(0, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
    assertNotEquals(aid, analyzeRevision(p, revision).get("id"));
    assertEquals(dev.javablueprints.engine.ProgramEngine.VERSION, w.analysis(p, revision, null).get("analyzerVersion"));
  }

  List<String> switchTrace(dev.javablueprints.engine.EngineModel.Graph graph, String methodName, String dispatchLabel) {
    var method = graph.methods().stream().filter(m -> m.fullyQualifiedName().endsWith("." + methodName)).findFirst().orElseThrow();
    var nodes = graph.nodes().stream().collect(java.util.stream.Collectors.toMap(dev.javablueprints.engine.EngineModel.GraphNode::id, n -> n));
    var trace = new ArrayList<String>();
    String current = method.entryNodeId();
    for (int step = 0; step < 40; step++) {
      var node = nodes.get(current);
      assertNotNull(node);
      assertEquals(method.id(), node.methodId());
      assertNotEquals("ast_projection", node.executionRole());
      if (node.kind().equals("normal_exit")) return trace;
      if (node.executionRole().equals("statement")) trace.add(node.label());
      String from = current;
      var outgoing = graph.edges().stream().filter(e -> e.source().equals(from)).toList();
      if (node.kind().equals("switch_selector")) {
        current = outgoing.stream().filter(e -> dispatchLabel.equals("default") ? e.kind().equals("default")
            : e.kind().equals("case") && dispatchLabel.equals(e.label())).findFirst().orElseThrow().target();
      } else {
        assertEquals(1, outgoing.size(), "This fixture has one continuation except selector dispatch");
        current = outgoing.getFirst().target();
      }
    }
    throw new AssertionError("Switch fixture trace did not terminate");
  }

  @Test
  void switchGraphRoundTripsWithSelectorOnceFallthroughAndReadonlyDispatchNodes() throws Exception {
    String p = project();
    String source = "// 😀\nclass Main {int choose(int x){int result=0;switch(x){case 1:result+=1;case 2:result+=2;break;default:result=9;}return result;}}";
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(source), id(), "empty")), "id");
    var analysis = w.convert(analyzeRevision(p, revision), dev.javablueprints.engine.EngineModel.Analysis.class);
    var reply = send("GET", "/projects/" + p + "/revisions/" + revision + "/graph?analysisId=" + analysis.id(), null, null, null, null);
    assertEquals(200, reply.status, reply.body.toString());
    var graph = w.convert(obj(reply), dev.javablueprints.engine.EngineModel.Graph.class);
    assertEquals(analysis.graph(), graph);
    assertEquals(List.of("int result=0;", "x", "result+=1;", "result+=2;", "break;", "return result;"), switchTrace(graph, "choose", "1"));
    assertEquals(List.of("int result=0;", "x", "result+=2;", "break;", "return result;"), switchTrace(graph, "choose", "2"));
    assertEquals(List.of("int result=0;", "x", "result=9;", "return result;"), switchTrace(graph, "choose", "default"));
    var selector = graph.nodes().stream().filter(n -> n.kind().equals("switch_selector")).findFirst().orElseThrow();
    assertEquals("statement", selector.executionRole());
    assertEquals("x", source.substring(selector.sourceRange().startOffset(), selector.sourceRange().endOffset()));
    var readonly = graph.nodes().stream().filter(n -> n.kind().equals("switch_selector") || n.kind().equals("switch_case")).toList();
    for (var node : readonly) {
      assertTrue(node.allowedOperations().isEmpty());
      assertTrue(node.editableFields().isEmpty());
      assertTrue(node.editableFieldRanges().isEmpty());
      assertTrue(node.insertionPositions().isEmpty());
      if (node.kind().equals("switch_case")) {
        assertEquals("structural", node.executionRole());
        String entry = source.substring(node.sourceRange().startOffset(), node.sourceRange().endOffset());
        assertTrue(entry.startsWith("case") || entry.startsWith("default"));
      }
    }
    for (var node : List.of(selector, readonly.stream().filter(n -> n.kind().equals("switch_case")).findFirst().orElseThrow())) {
      String key = id();
      var body = map("baseRevisionId", revision, "analysisId", analysis.id(), "methodId", node.methodId(), "nodeId", node.id(),
          "operation", node.kind().equals("switch_selector") ? "replace_expression" : "delete_statement",
          "payload", node.kind().equals("switch_selector") ? map("field", "expression", "source", "2") : Map.of(), "intent", "semantic_edit");
      var submitted = post("/projects/" + p + "/changes", body, key, null);
      assertEquals(202, submitted.status, submitted.body.toString());
      var failed = waitJob(p, str(obj(submitted), "jobId"));
      assertEquals("failed", failed.get("status"));
      assertEquals("UNSUPPORTED_OPERATION", ((Map<?, ?>) failed.get("error")).get("code"));
      var proposal = w.resource(p, str(obj(submitted), "id"), "proposal");
      assertEquals("rejected", proposal.get("status"));
      assertFalse(proposal.containsKey("candidateRevisionId"));
      assertEquals(obj(submitted), obj(post("/projects/" + p + "/changes", body, key, null)), "Replay retains accepted response and creates no second job");
    }
    assertEquals(1, w.revisions(p, 100).size());
    assertEquals(2, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=? AND type='change'", Integer.class, uuid(p)));
    assertEquals(source, w.files(w.revision(p, revision)).get("Main.java"));
    var capabilities = obj(send("GET", "/capabilities", null, null, null, null));
    assertEquals("partial", ((Map<?, ?>) capabilities.get("switch_flow")).get("status"));
    assertEquals("traditional_statement_switch", ((Map<?, ?>) capabilities.get("switch_flow")).get("scope"));
    assertEquals("unknown", ((Map<?, ?>) capabilities.get("switch_flow")).get("exceptionalFlow"));
  }

  @Test
  void oldSwitchAnalysisIsHistoricalOnlyAndSourceProjectionEditRegeneratesGraph() throws Exception {
    String p = project();
    String source = "class Main {int choose(int x){switch(x){case 1:return 1;}return 0;}}";
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(source), id(), "empty")), "id");
    var fixture = new dev.javablueprints.engine.ProgramEngine().inspect(new dev.javablueprints.engine.EngineModel.SourceBundle(revision, w.files(w.revision(p, revision))));
    var old = w.decode(w.encode(fixture));
    old.put("analyzerVersion", "engine-0.4.0");
    w.putResource(p, fixture.id(), "analysis", old);
    assertEquals(old, obj(send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis?analysisId=" + fixture.id(), null, null, null, null)));
    assertEquals(404, send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis", null, null, null, null).status);
    var stale = map("baseRevisionId", revision, "analysisId", fixture.id(), "methodId", "m", "nodeId", "n", "operation", "replace_expression", "payload", map("field", "expression", "source", "2"), "intent", "semantic_edit");
    assertEquals(409, post("/projects/" + p + "/changes", stale, id(), null).status);
    assertEquals(0, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
    var current = w.convert(analyzeRevision(p, revision), dev.javablueprints.engine.EngineModel.Analysis.class);
    assertEquals("engine-0.5.0", current.analyzerVersion());
    assertEquals(List.of("x", "return 0;"), switchTrace(current.graph(), "choose", "default"), "No-match bypasses first case when default is absent");
    var selector = current.graph().nodes().stream().filter(n -> n.kind().equals("switch_selector")).findFirst().orElseThrow();
    var projection = current.graph().nodes().stream().filter(n -> n.kind().equals("expression") && n.sourceRange().equals(selector.sourceRange())).findFirst().orElseThrow();
    assertEquals("ast_projection", projection.executionRole());
    assertTrue(projection.allowedOperations().contains("replace_expression"));
    var body = map("baseRevisionId", revision, "analysisId", current.id(), "methodId", projection.methodId(), "nodeId", projection.id(), "operation", "replace_expression", "payload", map("field", "expression", "source", "2"), "intent", "semantic_edit");
    var submitted = post("/projects/" + p + "/changes", body, id(), null);
    assertEquals(202, submitted.status, submitted.body.toString());
    assertEquals("succeeded", waitJob(p, str(obj(submitted), "jobId")).get("status"));
    var proposal = w.resource(p, str(obj(submitted), "id"), "proposal");
    assertEquals("rejected", proposal.get("status"));
    assertEquals("unavailable", ((Map<?, ?>) proposal.get("checks")).get("compileStatus"));
    String candidateId = str(proposal, "candidateRevisionId");
    var changed = w.convert(analyzeRevision(p, candidateId), dev.javablueprints.engine.EngineModel.Analysis.class);
    var changedSelector = changed.graph().nodes().stream().filter(n -> n.kind().equals("switch_selector")).findFirst().orElseThrow();
    assertEquals("(2)", changedSelector.label());
    assertNotEquals(selector.id(), changedSelector.id());
    assertEquals(source, w.files(w.revision(p, revision)).get("Main.java"));
    assertEquals(current.graph(), w.convert(w.analysis(p, revision, current.id()).get("graph"), dev.javablueprints.engine.EngineModel.Graph.class));
    assertEquals(revision, w.project(p).get("headRevisionId"));
    assertEquals(409, post("/projects/" + p + "/head", map("expectedHeadRevisionId", revision, "candidateRevisionId", candidateId, "proposalId", proposal.get("id")), id(), revision).status);
  }

  @Test
  void symbolEnvironmentFencesCacheAndCommandsWhileHistoricalJsonRemainsReadable() throws Exception {
    String p = project();
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty")), "id");
    var fixture = new dev.javablueprints.engine.ProgramEngine().inspect(new dev.javablueprints.engine.EngineModel.SourceBundle(revision, w.files(w.revision(p, revision))));
    var original = w.decode(w.encode(fixture));
    for (String variant : List.of("stale_environment", "missing_environment", "old_engine", "old_map")) {
      var historical = new LinkedHashMap<>(original);
      String aid = id();
      historical.put("id", aid);
      if (variant.equals("stale_environment")) historical.put("symbolEnvironmentHash", "stale-environment");
      if (variant.equals("missing_environment")) { historical.remove("symbolEnvironmentHash"); historical.remove("semantics"); }
      if (variant.equals("old_engine")) historical.put("analyzerVersion", "engine-0.2.0");
      if (variant.equals("old_map")) historical.put("sourceMapVersion", "old-map");
      w.putResource(p, aid, "analysis", historical);
      assertEquals(404, send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis", null, null, null, null).status);
      assertEquals(historical, obj(send("GET", "/projects/" + p + "/revisions/" + revision + "/analysis?analysisId=" + aid, null, null, null, null)));
      var edit = map("baseRevisionId", revision, "analysisId", aid, "methodId", "m", "nodeId", "n", "operation", "delete_statement", "payload", Map.of(), "intent", "semantic_edit");
      assertEquals(409, post("/projects/" + p + "/changes", edit, id(), null).status);
      if (variant.equals("missing_environment")) {
        var old = w.convert(historical, dev.javablueprints.engine.EngineModel.Analysis.class);
        assertNull(old.symbolEnvironmentHash());
        assertNull(old.semantics().environment());
        assertTrue(old.semantics().symbols().isEmpty());
        assertTrue(old.semantics().references().isEmpty());
      }
    }
    assertEquals(0, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
    var current = analyzeRevision(p, revision);
    assertEquals(dev.javablueprints.engine.ProgramEngine.currentSymbolEnvironmentHash(), current.get("symbolEnvironmentHash"));
    // A newer stale-environment record cannot shadow an older compatible analysis.
    var stale = new LinkedHashMap<>(original);
    stale.put("id", id()); stale.put("symbolEnvironmentHash", "stale-environment");
    w.putResource(p, str(stale, "id"), "analysis", stale);
    assertEquals(current.get("id"), w.analysis(p, revision, null).get("id"));
    var capabilities = obj(send("GET", "/capabilities", null, null, null, null));
    assertEquals("partial", ((Map<?, ?>) capabilities.get("symbols")).get("status"));
    assertEquals("unknown", ((Map<?, ?>) capabilities.get("symbols")).get("runtimeDispatch"));
  }

  @Test
  void invalidParseHasNoFalselyResolvedSemanticBindings() throws Exception {
    String p = project();
    String source = "class Main { int value=1; void broken( {";
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(source), id(), "empty")), "id");
    var analysis = analyzeRevision(p, revision);
    assertEquals("invalid", analysis.get("parseStatus"));
    var model = (Map<?, ?>) analysis.get("semantics");
    assertTrue(((List<?>) model.get("references")).isEmpty());
    assertEquals(source, w.files(w.revision(p, revision)).get("Main.java"));
  }

  @Test
  void acceptedHistoricalChangeReplaysAfterEnvironmentUpgradeWithoutNewWork() throws Exception {
    String p = project();
    String revision = str(obj(post("/projects/" + p + "/revisions", sources(code), id(), "empty")), "id");
    var fixture = new dev.javablueprints.engine.ProgramEngine().inspect(new dev.javablueprints.engine.EngineModel.SourceBundle(revision, w.files(w.revision(p, revision))));
    var old = w.decode(w.encode(fixture));
    old.put("symbolEnvironmentHash", "prior-server-environment");
    w.putResource(p, fixture.id(), "analysis", old);
    String key = id(), proposalId = id(), jobId = id();
    var body = map("baseRevisionId", revision, "analysisId", fixture.id(), "methodId", "m", "nodeId", "n", "operation", "delete_statement", "payload", Map.of(), "intent", "semantic_edit");
    // Seed the durable state produced by a prior server environment, without mutating any
    // immutable analysis or changing the running JVM's actual environment fingerprint.
    var accepted = w.idem(p + ":change", key, body, 202, () -> {
      w.db.update("INSERT INTO jobs(id,project_id,type,status,input)VALUES(?,?,'change','failed',?::jsonb)", uuid(jobId), uuid(p), w.encode(body));
      var proposal = map("id", proposalId, "proposalId", proposalId, "projectId", p, "jobId", jobId, "baseRevisionId", revision, "status", "rejected", "command", body);
      w.putResource(p, proposalId, "proposal", proposal);
      return proposal;
    });
    var replay = post("/projects/" + p + "/changes", body, key, null);
    assertEquals(202, replay.status, replay.body.toString());
    assertEquals(accepted, obj(replay));
    assertEquals(409, post("/projects/" + p + "/changes", body, id(), null).status);
    assertEquals(1, w.db.queryForObject("SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p)));
    assertEquals(1, w.db.queryForObject("SELECT count(*) FROM resources WHERE project_id=? AND kind='proposal'", Integer.class, uuid(p)));
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
