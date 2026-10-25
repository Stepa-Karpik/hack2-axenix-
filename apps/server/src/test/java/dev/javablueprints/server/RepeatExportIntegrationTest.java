package dev.javablueprints.server;

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
import org.springframework.http.ContentDisposition;

/** HTTP/storage contracts only: no runner, source compilation, program execution or real email. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"jb.runner.enabled=false", "jb.origins=http://localhost:5174", "jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class RepeatExportIntegrationTest {
  static final String SCHEMA = "jbrepeatexport_" + UUID.randomUUID().toString().replace("-", "");

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @LocalServerPort int port;
  HttpClient http;
  String csrf;

  @BeforeEach
  void session() throws Exception {
    http =
        HttpClient.newBuilder()
            .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL))
            .build();
    csrf = data(send("GET", "/session", null, null)).get("csrfToken").toString();
  }

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbrepeatexport_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  record Reply(int status, Map<String, Object> body) {}

  Reply send(String method, String path, Object body, String key) throws Exception {
    var request =
        HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
            .header("Origin", "http://localhost:5174")
            .header("Content-Type", "application/json");
    if (csrf != null) request.header("X-CSRF-Token", csrf);
    if (key != null) request.header("Idempotency-Key", key);
    var response =
        http.send(
            request
                .method(
                    method,
                    body == null
                        ? HttpRequest.BodyPublishers.noBody()
                        : HttpRequest.BodyPublishers.ofString(w.encode(body)))
                .build(),
            HttpResponse.BodyHandlers.ofString());
    var reply = new Reply(response.statusCode(), w.decode(response.body()));
    if (reply.body.get("data") instanceof Map<?, ?> d && d.get("csrfToken") != null)
      csrf = d.get("csrfToken").toString();
    return reply;
  }

  Map<String, Object> data(Reply reply) {
    return (Map<String, Object>) reply.body.get("data");
  }

  String project() {
    return w.createProject("repeat-export-fixture-" + id()).get("id").toString();
  }

  Map<String, Object> snapshot(String p, String expected, String note) {
    return w.save(
        p,
        expected,
        Map.of(
            "Main.java",
            "public class Main { public static void main(String[] args) {} }\n",
            "notes.md",
            note),
        Map.of(),
        List.of(),
        "text_edit",
        "semantic_edit",
        true);
  }

  String finished(String p, String type, Map<String, Object> input, String status) {
    String j = w.enqueue(p, type, input).get("id").toString();
    w.db.update("UPDATE jobs SET status=?,finished_at=now() WHERE id=?", status, uuid(j));
    return j;
  }

  Map<String, Object> input(String p, String job) {
    return w.decode(
        w.db.queryForObject(
            "SELECT input::text FROM jobs WHERE project_id=? AND id=?",
            String.class,
            uuid(p),
            uuid(job)));
  }

  int jobs(String p) {
    return w.db.queryForObject(
        "SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(p));
  }

  String repeatPath(String p, String job) {
    return "/projects/" + p + "/runs/" + job + "/repeat";
  }

  void error(Reply reply, int status, String code) {
    assertEquals(status, reply.status, reply.body.toString());
    assertEquals(code, ((Map<?, ?>) reply.body.get("error")).get("code"));
  }

  @Test
  void runRepeatKeepsOriginalRevisionEntrypointArgumentsAndInputAfterHeadChanges()
      throws Exception {
    String p = project();
    var old = snapshot(p, "empty", "old\n");
    var payload =
        map(
            "revisionId",
            old.get("id"),
            "profileId",
            "java21-v1",
            "entryPoint",
            "Main",
            "argv",
            List.of("--name", "Альфа", ""),
            "stdinUtf8",
            "42\nтест\r\n",
            "interactive",
            false);
    String original = finished(p, "run", payload, "succeeded");
    var head = snapshot(p, old.get("id").toString(), "new head\n");
    int before = jobs(p);
    String key = id();
    var response = send("POST", repeatPath(p, original), null, key);
    assertEquals(202, response.status, response.body.toString());
    String repeated = data(response).get("id").toString();
    assertNotEquals(original, repeated);
    assertEquals("queued", data(response).get("status"));
    assertEquals(old.get("id"), data(response).get("revisionId"));
    assertEquals(payload, input(p, repeated));
    assertEquals(payload, input(p, original));
    assertEquals(head.get("id"), w.project(p).get("headRevisionId"));
    assertEquals(before + 1, jobs(p));
    var again = send("POST", repeatPath(p, original), null, key);
    assertEquals(202, again.status, again.body.toString());
    assertEquals(repeated, data(again).get("id"));
    assertEquals(before + 1, jobs(p));
    var changed = new LinkedHashMap<>(payload);
    changed.put("stdinUtf8", "different\n");
    String other = finished(p, "run", changed, "failed");
    error(send("POST", repeatPath(p, other), null, key), 409, "IDEMPOTENCY_CONFLICT");
    assertEquals(before + 2, jobs(p));
  }

  @Test
  void comparisonRepeatPreservesExactImmutableSuitePairAndProfile() throws Exception {
    String p = project();
    var base = snapshot(p, "empty", "base\n");
    var candidate = snapshot(p, base.get("id").toString(), "candidate\n");
    String suite = id();
    var suiteData =
        map(
            "id",
            suite,
            "projectId",
            p,
            "mode",
            "console",
            "entryPoint",
            "Main",
            "comparisonPolicyId",
            "exact-v1",
            "cases",
            List.of(
                map(
                    "id",
                    id(),
                    "name",
                    "UTF8 oracle",
                    "stdinUtf8",
                    "ёж\n",
                    "argv",
                    List.of("one"),
                    "expectedExitCodes",
                    List.of(0),
                    "expectedStdout",
                    "",
                    "expectedStderr",
                    "")));
    w.putResource(p, suite, "suite", suiteData);
    var payload =
        map(
            "baseRevisionId",
            base.get("id"),
            "candidateRevisionId",
            candidate.get("id"),
            "suiteVersionId",
            suite,
            "profileId",
            "java21-v1");
    String original = finished(p, "compare", payload, "failed");
    var newer = snapshot(p, candidate.get("id").toString(), "head after comparison\n");
    var response = send("POST", repeatPath(p, original), null, id());
    assertEquals(202, response.status, response.body.toString());
    String repeated = data(response).get("id").toString();
    assertEquals("compare", data(response).get("type"));
    assertEquals(payload, input(p, repeated));
    assertEquals(suiteData, w.resource(p, suite, "suite"));
    assertEquals(newer.get("id"), w.project(p).get("headRevisionId"));
    assertNotEquals(newer.get("id"), input(p, repeated).get("candidateRevisionId"));
  }

  @Test
  void repeatRejectsActiveForeignAndUnsupportedJobsWithoutEnqueueing() throws Exception {
    String p = project(), foreign = project();
    var revision = snapshot(p, "empty", "source\n");
    var payload =
        map(
            "revisionId",
            revision.get("id"),
            "profileId",
            "java21-v1",
            "entryPoint",
            "Main",
            "argv",
            List.of(),
            "stdinUtf8",
            "");
    String queued = w.enqueue(p, "run", payload).get("id").toString(),
        running = finished(p, "run", payload, "running"),
        unsupported =
            finished(
                p,
                "compile",
                map("revisionId", revision.get("id"), "profileId", "java21-v1"),
                "succeeded"),
        foreignJob = finished(foreign, "run", payload, "cancelled");
    int before = jobs(p);
    error(send("POST", repeatPath(p, queued), null, id()), 409, "JOB_ACTIVE");
    error(send("POST", repeatPath(p, running), null, id()), 409, "JOB_ACTIVE");
    error(send("POST", repeatPath(p, unsupported), null, id()), 400, "INVALID_REQUEST");
    error(send("POST", repeatPath(p, foreignJob), null, id()), 404, "RESOURCE_NOT_FOUND");
    error(send("POST", repeatPath(p, id()), null, id()), 404, "RESOURCE_NOT_FOUND");
    assertEquals(before, jobs(p));
    error(send("POST", repeatPath(foreign, foreignJob), null, id()), 404, "RESOURCE_NOT_FOUND");
    assertEquals(before, jobs(p));
  }

  HttpResponse<byte[]> download(String p, String revision, String path) throws Exception {
    return http.send(
        HttpRequest.newBuilder(
                URI.create(
                    "http://127.0.0.1:"
                        + port
                        + "/api/v1/projects/"
                        + p
                        + "/revisions/"
                        + revision
                        + "/download?path="
                        + URLEncoder.encode(path, StandardCharsets.UTF_8)))
            .GET()
            .build(),
        HttpResponse.BodyHandlers.ofByteArray());
  }

  @Test
  void sourceDownloadPreservesRawBomCrlfUtf8NameAndCanonicalPlainExtension() throws Exception {
    String p = project(), foreign = project();
    String name = "заметки/данные.txt", raw = "\uFEFF<note>ёж & raw</note>\r\nsecond\r\n";
    byte[] expected = raw.getBytes(StandardCharsets.UTF_8);
    var revision =
        w.save(
            p,
            "empty",
            Map.of(name, raw, "README.md", "plain café\n"),
            Map.of(name, expected),
            List.of("заметки"),
            "import",
            "semantic_edit",
            true);
    String id = revision.get("id").toString();
    var response = download(p, id, name);
    assertEquals(200, response.statusCode());
    assertArrayEquals(expected, response.body());
    assertEquals(
        "application/octet-stream", response.headers().firstValue("Content-Type").orElseThrow());
    assertEquals("nosniff", response.headers().firstValue("X-Content-Type-Options").orElseThrow());
    assertEquals(
        "данные.txt",
        ContentDisposition.parse(response.headers().firstValue("Content-Disposition").orElseThrow())
            .getFilename());
    assertTrue(
        response.headers().firstValue("Content-Disposition").orElseThrow().contains("filename*="));
    var plain = download(p, id, "README.md");
    assertEquals(200, plain.statusCode());
    assertArrayEquals("plain café\n".getBytes(StandardCharsets.UTF_8), plain.body());
    assertEquals(
        "README.md",
        ContentDisposition.parse(plain.headers().firstValue("Content-Disposition").orElseThrow())
            .getFilename());
    assertEquals(404, download(p, id, "missing.txt").statusCode());
    assertEquals(400, download(p, id, "../README.md").statusCode());
    assertEquals(404, download(foreign, id, name).statusCode());
    assertEquals(404, download(p, Workspace.id(), name).statusCode());
  }

  @Test
  void privateProjectRepeatAndDownloadRequireAuthorizedAccount() throws Exception {
    String p = project(),
        account = id(),
        username = "export_" + account.replace("-", "").substring(0, 16),
        password = "trusted-export-password-123";
    w.db.update(
        "INSERT INTO accounts(id,username,email,password_hash,display_name)VALUES(?::uuid,?,?,?,?)",
        account,
        username,
        username + "@example.invalid",
        AccountPasswords.encode(password),
        "Export owner");
    w.db.update(
        "UPDATE projects SET owner_id=?::uuid,visibility='private' WHERE id=?::uuid", account, p);
    var revision = snapshot(p, "empty", "private\n");
    String original =
        finished(
            p,
            "run",
            map(
                "revisionId",
                revision.get("id"),
                "profileId",
                "java21-v1",
                "entryPoint",
                "Main",
                "argv",
                List.of(),
                "stdinUtf8",
                ""),
            "succeeded");
    int before = jobs(p);
    assertEquals(401, download(p, revision.get("id").toString(), "notes.md").statusCode());
    error(send("POST", repeatPath(p, original), null, id()), 401, "AUTH_REQUIRED");
    assertEquals(before, jobs(p));
    var login =
        send("POST", "/auth/login", map("identifier", username, "password", password), id());
    assertEquals(200, login.status, login.body.toString());
    assertEquals(200, download(p, revision.get("id").toString(), "notes.md").statusCode());
    assertEquals(202, send("POST", repeatPath(p, original), null, id()).status);
    assertEquals(before + 1, jobs(p));
  }
}
