package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;

/** Real PostgreSQL authorization/storage boundary. No input Java is compiled or executed. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.MOCK,
    properties = {
      "jb.hosting.enabled=true",
      "jb.public-url=https://java-blueprints.karpovprod.ru",
      "server.servlet.session.cookie.secure=true",
      "jb.runner.enabled=false",
      "jb.smtp.host="
    })
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class HostedAccessIntegrationTest {
  static final String SCHEMA = "jbhosttest_" + UUID.randomUUID().toString().replace("-", "");
  static final String HOST = "java-blueprints.karpovprod.ru";
  static final String ORIGIN = "https://" + HOST;
  static final String SOURCE = "public class Main { public static void main(String[] args) {} }\n";

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry properties) {
    properties.add("spring.flyway.default-schema", () -> SCHEMA);
    properties.add("spring.flyway.schemas", () -> SCHEMA);
    properties.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  @Autowired WebApplicationContext context;
  @Autowired LocalSecurity security;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;

  MockMvc mvc;
  String owner, editor, viewer, outsider, privateProject, publicProject, legacyProject;
  String privateRevision, publicRevision, legacyRevision;

  @BeforeEach
  void fixtures() {
    mvc = MockMvcBuilders.webAppContextSetup(context).addFilters(security).build();
    owner = account();
    editor = account();
    viewer = account();
    outsider = account();
    privateProject = project(owner, "private");
    publicProject = project(owner, "public");
    legacyProject = project(null, "legacy_local");
    privateRevision = revision(privateProject);
    publicRevision = revision(publicProject);
    legacyRevision = revision(legacyProject);
    for (var member : Map.of(editor, "editor", viewer, "viewer").entrySet())
      w.db.update(
          "INSERT INTO project_members(project_id,account_id,role)VALUES(?::uuid,?::uuid,?)",
          privateProject,
          member.getKey(),
          member.getValue());
  }

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbhosttest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  String account() {
    String actor = id();
    w.db.update(
        "INSERT INTO accounts(id,username,email,password_hash,display_name)VALUES(?::uuid,?,?,?,?)",
        actor,
        "h_" + actor.replace("-", "").substring(0, 20),
        actor + "@example.invalid",
        "unused-trusted-fixture",
        "Hosted fixture");
    return actor;
  }

  String project(String actor, String visibility) {
    String project = id();
    w.db.update(
        "INSERT INTO projects(id,name,owner_id,visibility)VALUES(?::uuid,?,?::uuid,?)",
        project,
        "hosted-" + project,
        actor,
        visibility);
    return project;
  }

  String revision(String project) {
    return w.save(
            project,
            "empty",
            Map.of("Main.java", SOURCE),
            Map.of(),
            "text_edit",
            "semantic_edit",
            true)
        .get("id")
        .toString();
  }

  record Snapshot(Map<String, Long> counts, List<Map<String, Object>> heads) {}

  Snapshot snapshot() {
    var counts = new LinkedHashMap<String, Long>();
    for (String table :
        List.of(
            "projects",
            "revisions",
            "resources",
            "artifacts",
            "jobs",
            "job_attempts",
            "idempotency",
            "audit_events",
            "layouts"))
      counts.put(table, w.db.queryForObject("SELECT count(*) FROM " + table, Long.class));
    return new Snapshot(
        counts,
        w.db.queryForList(
            "SELECT id,head_revision_id,original_revision_id FROM projects ORDER BY id"));
  }

  final class Client {
    final MockHttpSession session = new MockHttpSession(context.getServletContext());
    final String csrf = id();

    Client(String actor) {
      session.setAttribute("csrf", csrf);
      if (actor != null) {
        // The actual Accounts.actor still checks this generation against PostgreSQL on each
        // request.
        session.setAttribute("accountId", actor);
        session.setAttribute("authVersion", 1);
      }
    }

    MvcResult send(String method, String path, Object body, String key, String match)
        throws Exception {
      var request =
          request(HttpMethod.valueOf(method), URI.create("/api/v1" + path))
              .session(session)
              .header("Origin", ORIGIN)
              .header("X-CSRF-Token", csrf)
              .with(
                  r -> {
                    r.setServerName(HOST);
                    r.setServerPort(443);
                    r.setScheme("https");
                    r.setSecure(true);
                    return r;
                  });
      if (key != null) request.header("Idempotency-Key", key);
      if (match != null) request.header("If-Match", match);
      if (path.endsWith("/imports") || path.endsWith("/import-previews")) {
        request
            .contentType("multipart/form-data; boundary=hostedtest")
            .content("--hostedtest--\r\n");
      } else {
        request.contentType(MediaType.APPLICATION_JSON);
        if (body != null) request.content(w.encode(body));
      }
      return mvc.perform(request).andReturn();
    }

    MvcResult send(String method, String path, Object body) throws Exception {
      return send(method, path, body, id(), null);
    }
  }

  Map<String, Object> body(MvcResult result) throws Exception {
    return w.decode(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
  }

  Map<String, Object> data(MvcResult result) throws Exception {
    return (Map<String, Object>) body(result).get("data");
  }

  void status(int expected, MvcResult result) throws Exception {
    assertEquals(
        expected,
        result.getResponse().getStatus(),
        result.getResponse().getContentAsString(StandardCharsets.UTF_8));
  }

  void denied(int expected, String code, MvcResult result) throws Exception {
    status(expected, result);
    assertEquals(code, ((Map<?, ?>) body(result).get("error")).get("code"));
  }

  String path(String project, String suffix) {
    return "/projects/" + project + suffix;
  }

  @Test
  void guestCollectionCreateAndArchivePreviewCannotWriteOrReplayLegacyIdempotency()
      throws Exception {
    var guest = new Client(null);
    String key = id();
    var create = map("name", "must not be created");
    // Existing local guest receipts must not bypass the new HTTP guard after mode changes.
    w.db.update(
        "INSERT INTO idempotency(scope,key,payload_hash,response,status)"
            + " VALUES('projects',?::uuid,?,?::jsonb,201)",
        key,
        hash(w.encode(create)),
        w.encode(map("id", legacyProject)));
    var before = snapshot();
    denied(401, "AUTH_REQUIRED", guest.send("GET", "/projects", null));
    denied(401, "AUTH_REQUIRED", guest.send("POST", "/projects", create, key, null));
    denied(401, "AUTH_REQUIRED", guest.send("POST", "/archive-previews", map()));
    assertEquals(before, snapshot());
    var session = data(guest.send("GET", "/session", null));
    assertEquals("anonymous", session.get("mode"));
    Map<?, ?> capabilities = (Map<?, ?>) session.get("capabilities");
    assertEquals(false, capabilities.get("legacyGuestWorkspace"));
    assertEquals(false, capabilities.get("projectCreation"));
    assertEquals(false, capabilities.get("projectExport"));
  }

  @Test
  void mvcNormalizedRoutesCannotBypassHostedGatesWithMatrixParametersOrEncoding() throws Exception {
    var guest = new Client(null);
    var before = snapshot();
    for (String collection : List.of("/projects;ignored=x", "/%70rojects")) {
      denied(401, "AUTH_REQUIRED", guest.send("GET", collection, null));
      denied(401, "AUTH_REQUIRED", guest.send("POST", collection, map("name", "forbidden")));
    }
    denied(401, "AUTH_REQUIRED", guest.send("POST", "/archive-previews;ignored=x", map()));
    for (String prefix : List.of("/projects;ignored=x/", "/%70rojects/")) {
      denied(404, "RESOURCE_NOT_FOUND", guest.send("GET", prefix + legacyProject, null));
      denied(401, "AUTH_REQUIRED", guest.send("POST", prefix + publicProject + "/archives", map()));
      denied(401, "AUTH_REQUIRED", guest.send("GET", prefix + privateProject, null));
    }
    denied(
        404,
        "RESOURCE_NOT_FOUND",
        guest.send("GET", "/projects/" + legacyProject + ";ignored=x", null));
    assertEquals(before, snapshot());
  }

  @Test
  void everyActorIsDeniedKnownLegacyReadsWritesImportsAndExecutionWithoutStorageChanges()
      throws Exception {
    var before = snapshot();
    for (String actor : Arrays.asList(null, owner, editor, outsider)) {
      var client = new Client(actor);
      for (String suffix :
          List.of(
              "",
              "/revisions",
              "/revisions/" + legacyRevision,
              "/revisions/" + legacyRevision + "/download?path=Main.java",
              "/artifacts/" + id(),
              "/archives/" + id(),
              "/jobs/" + id()))
        denied(404, "RESOURCE_NOT_FOUND", client.send("GET", path(legacyProject, suffix), null));
      for (String suffix :
          List.of(
              "/revisions",
              "/changes",
              "/imports",
              "/import-previews",
              "/archive-imports",
              "/exports",
              "/archives",
              "/runs",
              "/comparisons"))
        denied(
            404,
            "RESOURCE_NOT_FOUND",
            client.send("POST", path(legacyProject, suffix), map(), id(), "empty"));
    }
    assertEquals(before, snapshot());
  }

  @Test
  void publicOwnedGetAndExactSourceDownloadSurviveButGuestMaterializationAndRunAreDenied()
      throws Exception {
    var guest = new Client(null);
    var before = snapshot();
    status(200, guest.send("GET", path(publicProject, ""), null));
    status(200, guest.send("GET", path(publicProject, "/revisions/" + publicRevision), null));
    var source =
        guest.send(
            "GET",
            path(publicProject, "/revisions/" + publicRevision + "/download?path=Main.java"),
            null);
    status(200, source);
    assertArrayEquals(
        SOURCE.getBytes(StandardCharsets.UTF_8), source.getResponse().getContentAsByteArray());
    denied(
        401,
        "AUTH_REQUIRED",
        guest.send("POST", path(publicProject, "/exports"), map("revisionId", publicRevision)));
    denied(401, "AUTH_REQUIRED", guest.send("POST", path(publicProject, "/archives"), map()));
    denied(
        401,
        "AUTH_REQUIRED",
        guest.send("POST", path(publicProject, "/runs"), run(publicRevision)));
    denied(
        401,
        "AUTH_REQUIRED",
        guest.send("POST", path(publicProject, "/archive-imports"), map(), id(), "empty"));
    assertEquals(before, snapshot());
  }

  @Test
  void privateOwnerEditorViewerAndOutsiderRemainDistinctWithActualWrites() throws Exception {
    var before = snapshot();
    denied(401, "AUTH_REQUIRED", new Client(null).send("GET", path(privateProject, ""), null));
    denied(403, "ACCESS_DENIED", new Client(outsider).send("GET", path(privateProject, ""), null));
    var reader = new Client(viewer);
    status(200, reader.send("GET", path(privateProject, ""), null));
    denied(
        403,
        "ACCESS_DENIED",
        reader.send("POST", path(privateProject, "/runs"), run(privateRevision)));
    denied(
        403,
        "ACCESS_DENIED",
        reader.send(
            "POST",
            path(privateProject, "/revisions"),
            edited(SOURCE + "// forbidden\n"),
            id(),
            privateRevision));
    assertEquals(before, snapshot());
    var saved =
        new Client(editor)
            .send(
                "POST",
                path(privateProject, "/revisions"),
                edited(SOURCE + "// editor\n"),
                id(),
                privateRevision);
    status(201, saved);
    String next = data(saved).get("id").toString();
    assertEquals(next, w.project(privateProject).get("headRevisionId"));
    var ownerSaved =
        new Client(owner)
            .send(
                "POST",
                path(privateProject, "/revisions"),
                edited(SOURCE + "// owner\n"),
                id(),
                next);
    status(201, ownerSaved);
    assertEquals(data(ownerSaved).get("id"), w.project(privateProject).get("headRevisionId"));
    assertEquals(before.counts().get("jobs"), snapshot().counts().get("jobs"));
  }

  @Test
  void authenticatedViewerCanExportReadableSnapshotsButCannotCreateLegacyWorkspace()
      throws Exception {
    var reader = new Client(viewer);
    var before = snapshot();
    denied(403, "ACCESS_DENIED", reader.send("GET", "/projects?scope=legacy", null));
    denied(403, "ACCESS_DENIED", reader.send("GET", "/projects?scope=default&scope=legacy", null));
    assertEquals(before, snapshot());
    var exported =
        reader.send("POST", path(privateProject, "/exports"), map("revisionId", privateRevision));
    status(201, exported);
    assertNotNull(data(exported).get("artifactId"));
    var archive = reader.send("POST", path(privateProject, "/archives"), map());
    status(201, archive);
    assertNotNull(data(archive).get("downloadUrl"));
    assertEquals(before.counts().get("artifacts") + 2, snapshot().counts().get("artifacts"));
    assertEquals(before.counts().get("jobs"), snapshot().counts().get("jobs"));
    assertEquals(privateRevision, w.project(privateProject).get("headRevisionId"));
  }

  @Test
  void authenticatedCreationIsPrivateOwnedIdempotentAndListExcludesAllLegacyRows()
      throws Exception {
    var client = new Client(owner);
    String key = id();
    var input = map("name", "owned hosted fixture");
    var created = client.send("POST", "/projects", input, key, null);
    status(201, created);
    String project = data(created).get("id").toString();
    var row =
        w.db.queryForMap(
            "SELECT owner_id::text,visibility FROM projects WHERE id=?::uuid", project);
    assertEquals(owner, row.get("owner_id"));
    assertEquals("private", row.get("visibility"));
    var beforeReplay = snapshot();
    var replay = client.send("POST", "/projects", input, key, null);
    status(201, replay);
    assertEquals(project, data(replay).get("id"));
    assertEquals(beforeReplay, snapshot());
    var listing = client.send("GET", "/projects?limit=100", null);
    status(200, listing);
    List<Map<String, Object>> rows = (List<Map<String, Object>>) body(listing).get("data");
    Set<Object> ids = new HashSet<>(rows.stream().map(r -> r.get("id")).toList());
    assertTrue(ids.containsAll(List.of(project, privateProject, publicProject)));
    assertFalse(ids.contains(legacyProject));
    assertTrue(rows.stream().allMatch(r -> owner.equals(r.get("ownerId"))));
  }

  Map<String, Object> edited(String content) {
    return map("files", List.of(map("path", "Main.java", "content", content)));
  }

  Map<String, Object> run(String revision) {
    return map(
        "revisionId",
        revision,
        "profileId",
        "java21-v1",
        "entryPoint",
        "Main",
        "argv",
        List.of(),
        "stdinUtf8",
        "",
        "interactive",
        false);
  }
}
