package dev.javablueprints.server;

import static dev.javablueprints.server.ProjectArchiveCodec.*;
import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"jb.runner.enabled=false", "jb.origins=http://localhost:5174"})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ProjectArchiveIntegrationTest {
  static final String SCHEMA = "jbtest_" + UUID.randomUUID().toString().replace("-", "");

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  // This test verifies archive HTTP/storage and enqueue contracts. Real worker
  // execution is covered by the Docker browser replay; it must not race schema teardown.
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;
  @LocalServerPort int port;
  HttpClient http;
  String csrf;

  @BeforeEach
  void session() throws Exception {
    http =
        HttpClient.newBuilder()
            .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL))
            .build();
    csrf = object(data(send("GET", "/session", null, null, null))).get("csrfToken").toString();
  }

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbtest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  record Reply(int status, Map<String, Object> body) {}

  Reply send(String method, String path, Object body, String key, String match) throws Exception {
    var builder =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
            .header("Origin", "http://localhost:5174")
            .header("Content-Type", "application/json");
    if (csrf != null) builder.header("X-CSRF-Token", csrf);
    if (key != null) builder.header("Idempotency-Key", key);
    if (match != null) builder.header("If-Match", match);
    var response =
        http.send(
            builder
                .method(
                    method,
                    body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(w.encode(body)))
                .build(),
            HttpResponse.BodyHandlers.ofString());
    return new Reply(response.statusCode(), w.decode(response.body()));
  }

  Object data(Reply response) {
    return response.body.get("data");
  }

  String project() throws Exception {
    var response =
        send("POST", "/projects", map("name", "archive-integration-" + id()), id(), null);
    assertEquals(201, response.status, response.body.toString());
    return object(data(response)).get("id").toString();
  }

  @Test
  void completeArchiveRestoresFreshHistoryRawTreeAndOnlyInertHistoricalEvidence() throws Exception {
    String source = project(), target = project();
    String raw =
        "\uFEFFpublic class Main { public static void main(String[] a){System.out.println(5);}"
            + " }\r\n";
    var first =
        w.save(
            source,
            "empty",
            Map.of("Main.java", raw, "notes.txt", "keep\n"),
            Map.of("Main.java", raw.getBytes(StandardCharsets.UTF_8)),
            List.of("empty"),
            "import",
            "semantic_edit",
            true);
    var detached =
        w.save(
            source,
            first.get("id").toString(),
            Map.of(
                "Main.java",
                w.files(first).get("Main.java") + "// detached\n",
                "notes.txt",
                "keep\n"),
            Map.of(),
            List.of("empty"),
            "graph_edit",
            "preserve_behavior",
            false);
    var head =
        w.save(
            source,
            first.get("id").toString(),
            Map.of(
                "Main.java", w.files(first).get("Main.java") + "// head\n", "notes.txt", "keep\n"),
            Map.of(),
            List.of("empty", "deep/folder"),
            "text_edit",
            "semantic_edit",
            true);
    var analysis =
        new dev.javablueprints.engine.ProgramEngine()
            .inspect(
                new dev.javablueprints.engine.EngineModel.SourceBundle(
                    first.get("id").toString(), w.javaFiles(first)));
    w.putResource(source, analysis.id(), "analysis", analysis);
    String suite = id(), report = id();
    w.putResource(
        source,
        suite,
        "suite",
        map(
            "id",
            suite,
            "projectId",
            source,
            "entryPoint",
            "Main",
            "mode",
            "console",
            "cases",
            List.of(map("id", "five", "expectedStdout", "5\n", "expectedExitCode", 0))));
    // Synthetic historical verdict tests inert import; it is not runtime evidence.
    w.putResource(
        source,
        report,
        "comparison",
        map(
            "id",
            report,
            "projectId",
            source,
            "baseRevisionId",
            first.get("id"),
            "candidateRevisionId",
            head.get("id"),
            "suiteVersionId",
            suite,
            "outcome",
            "matched_on_tests"));
    String method = analysis.graph().methods().getFirst().id();
    var layout =
        map(
            "analysisId",
            analysis.id(),
            "revisionId",
            first.get("id"),
            "positions",
            List.of(),
            "viewport",
            map("x", 12, "y", 3, "zoom", 1));
    w.db.update(
        "INSERT INTO"
            + " layouts(project_id,revision_id,analysis_id,method_id,version,data)VALUES(?,?,?,?,?,?::jsonb)",
        uuid(source),
        uuid(first.get("id").toString()),
        uuid(analysis.id()),
        method,
        1,
        w.encode(layout));
    var workspace = map("version", 1, "panels", List.of(), "inertTestState", true);
    var exported =
        send("POST", "/projects/" + source + "/archives", map("workspace", workspace), id(), null);
    assertEquals(201, exported.status, exported.body.toString());
    var metadata = object(data(exported));
    String artifact = metadata.get("artifactId").toString();
    byte[] bytes =
        w.db.queryForObject(
            "SELECT bytes FROM artifacts WHERE project_id=? AND id=?",
            byte[].class,
            uuid(source),
            uuid(artifact));
    assertEquals(hash(bytes), metadata.get("sha256"));
    var archive = w.decode(new String(bytes, StandardCharsets.UTF_8));
    var payload = validate(archive);
    assertEquals(3, objects(payload.get("revisions"), 64).size());
    assertEquals(1, objects(payload.get("layouts"), 512).size());
    assertFalse(payload.containsKey("ownerId"));
    assertEquals(workspace, payload.get("workspace"));
    assertTrue(
        new String(bytes, StandardCharsets.UTF_8)
            .contains("ownerId")); // semantic declaration ownership is legitimate
    var preview = send("POST", "/archive-previews", map("archive", archive), id(), null);
    assertEquals(200, preview.status, preview.body.toString());
    String key = id();
    var body = map("archive", archive);
    var imported = send("POST", "/projects/" + target + "/archive-imports", body, key, "empty");
    assertEquals(201, imported.status, imported.body.toString());
    var receipt = object(data(imported));
    var ids = object(receipt.get("revisionIdMap"));
    assertEquals(3, ids.size());
    assertEquals("unverified", receipt.get("verificationStatus"));
    assertEquals("inert", receipt.get("historicalEvidence"));
    assertEquals(ids.get(head.get("id")), w.project(target).get("headRevisionId"));
    assertEquals(ids.get(first.get("id")), w.project(target).get("originalRevisionId"));
    for (var old : List.of(first, detached, head)) {
      String next = ids.get(old.get("id")).toString();
      assertNotEquals(old.get("id"), next);
      var restored = w.revision(target, next);
      assertEquals(w.files(old), w.files(restored));
      assertEquals(w.directories(old), w.directories(restored));
      assertEquals(old.get("treeHash"), restored.get("treeHash"));
      assertEquals("unverified", restored.get("verificationStatus"));
    }
    var restoredFirst = w.revision(target, ids.get(first.get("id")).toString());
    var file =
        object(
            ((List<?>) restoredFirst.get("files"))
                .stream()
                    .filter(f -> object(f).get("path").equals("Main.java"))
                    .findFirst()
                    .orElseThrow());
    byte[] copied =
        w.db.queryForObject(
            "SELECT bytes FROM artifacts WHERE project_id=? AND id=?",
            byte[].class,
            uuid(target),
            uuid(file.get("rawArtifactRef").toString()));
    assertArrayEquals(raw.getBytes(StandardCharsets.UTF_8), copied);
    assertThrows(ApiError.class, () -> w.resource(target, report, "comparison"));
    assertThrows(ApiError.class, () -> w.resource(target, suite, "suite"));
    assertThrows(ApiError.class, () -> w.resource(target, analysis.id(), "analysis"));
    assertEquals(
        0,
        w.db.queryForObject(
            "SELECT count(*) FROM layouts WHERE project_id=?", Integer.class, uuid(target)));
    assertEquals(
        1,
        w.db.queryForObject(
            "SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(target)));
    var repeated = send("POST", "/projects/" + target + "/archive-imports", body, key, "empty");
    assertEquals(201, repeated.status);
    assertEquals(data(imported), data(repeated));
    var blocked = send("POST", "/projects/" + target + "/archive-imports", body, id(), "empty");
    assertEquals(409, blocked.status);
    var altered = object(JSON.readValue(bytes(archive), Map.class));
    object(altered.get("payload")).put("createdAt", "2026-10-25T01:00:00Z");
    var resealed = seal(object(altered.get("payload")));
    assertEquals(
        409,
        send(
                "POST",
                "/projects/" + target + "/archive-imports",
                map("archive", resealed),
                key,
                "empty")
            .status);
    assertEquals(head.get("id"), w.project(source).get("headRevisionId"));
    var inert = w.resource(target, receipt.get("receiptId").toString(), "archive_import");
    assertEquals(archive, inert.get("archive"));
    // A second export retains the first inert receipt as provenance, without activating it.
    var reexported = send("POST", "/projects/" + target + "/archives", map(), id(), null);
    assertEquals(201, reexported.status, reexported.body.toString());
    byte[] again =
        w.db.queryForObject(
            "SELECT bytes FROM artifacts WHERE project_id=? AND id=?",
            byte[].class,
            uuid(target),
            uuid(object(data(reexported)).get("artifactId").toString()));
    var nested = w.decode(new String(again, StandardCharsets.UTF_8));
    var nestedPayload = validate(nested);
    var oldReceipt =
        objects(nestedPayload.get("resources"), MAX_RESOURCES).stream()
            .filter(r -> r.get("kind").equals("archive_import"))
            .findFirst()
            .orElseThrow();
    assertEquals(archive, object(oldReceipt.get("data")).get("archive"));
    String secondTarget = project();
    var secondImport =
        send(
            "POST",
            "/projects/" + secondTarget + "/archive-imports",
            map("archive", nested),
            id(),
            "empty");
    assertEquals(201, secondImport.status, secondImport.body.toString());
    var secondReceipt = object(data(secondImport));
    assertNotEquals(receipt.get("headRevisionId"), secondReceipt.get("headRevisionId"));
    assertEquals("unverified", secondReceipt.get("verificationStatus"));
    assertThrows(ApiError.class, () -> w.resource(secondTarget, report, "comparison"));
    assertThrows(
        ApiError.class,
        () -> w.resource(secondTarget, receipt.get("receiptId").toString(), "archive_import"));
  }

  @Test
  void tamperingAndMissingPreconditionCannotCreateRevisions() throws Exception {
    String target = project();
    var archive = seal(ProjectArchiveCodecTest.payload("class Main{}\n"));
    object(archive.get("manifest")).put("payloadSha256", "0".repeat(64));
    assertEquals(
        400, send("POST", "/archive-previews", map("archive", archive), id(), null).status);
    assertEquals(
        400,
        send(
                "POST",
                "/projects/" + target + "/archive-imports",
                map("archive", archive),
                id(),
                "empty")
            .status);
    assertEquals(
        428,
        send(
                "POST",
                "/projects/" + target + "/archive-imports",
                map("archive", archive),
                id(),
                null)
            .status);
    assertNull(w.project(target).get("headRevisionId"));
    assertEquals(0, w.revisions(target, 100).size());
  }
}
