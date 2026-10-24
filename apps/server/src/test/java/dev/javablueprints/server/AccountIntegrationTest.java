package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.net.*;
import java.net.http.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"jb.runner.enabled=false", "jb.origins=http://localhost:5174", "jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AccountIntegrationTest {
  static final String SCHEMA = "jbaccounttest_" + UUID.randomUUID().toString().replace("-", "");
  static final String PASSWORD = "original-password-123";

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  @org.springframework.test.context.bean.override.mockito.MockitoSpyBean Accounts accounts;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @LocalServerPort int port;

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbaccounttest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  record Reply(int status, Map<String, Object> body) {
    Map<String, Object> data() {
      return (Map<String, Object>) body.get("data");
    }
  }

  class Client {
    HttpClient http =
        HttpClient.newBuilder()
            .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL))
            .build();
    String csrf;

    Client() throws Exception {
      csrf = send("GET", "/session", null).data().get("csrfToken").toString();
    }

    Reply send(String method, String path, Object body) throws Exception {
      boolean multipart = path.endsWith("/imports") || path.endsWith("/import-previews");
      var request =
          HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
              .header("Origin", "http://localhost:5174")
              .header(
                  "Content-Type",
                  multipart ? "multipart/form-data; boundary=accounttest" : "application/json")
              .header("Idempotency-Key", id());
      if (csrf != null) request.header("X-CSRF-Token", csrf);
      if (method.equals("POST") && path.endsWith("/revisions")) request.header("If-Match", "empty");
      var response =
          http.send(
              request
                  .method(
                      method,
                      multipart
                          ? HttpRequest.BodyPublishers.ofString("--accounttest--\r\n")
                          : body == null
                              ? HttpRequest.BodyPublishers.noBody()
                              : HttpRequest.BodyPublishers.ofString(w.encode(body)))
                  .build(),
              HttpResponse.BodyHandlers.ofString());
      var reply = new Reply(response.statusCode(), w.decode(response.body()));
      if (reply.body.get("data") instanceof Map<?, ?> data && data.get("csrfToken") != null)
        csrf = data.get("csrfToken").toString();
      return reply;
    }

    String register(String name) throws Exception {
      var reply =
          send(
              "POST",
              "/auth/register",
              map("username", name, "email", name + "@example.com", "password", PASSWORD));
      assertEquals(201, reply.status, reply.body.toString());
      assertEquals(false, reply.data().get("emailDelivery"));
      assertFalse(reply.body.toString().contains("token="));
      return ((Map<?, ?>) reply.data().get("user")).get("id").toString();
    }

    void login(String name) throws Exception {
      assertEquals(
          200, send("POST", "/auth/login", map("identifier", name, "password", PASSWORD)).status);
    }

    String project() throws Exception {
      var reply = send("POST", "/projects", map("name", "account-test"));
      assertEquals(201, reply.status, reply.body.toString());
      return reply.data().get("id").toString();
    }

    Object rawData(String path) throws Exception {
      return send("GET", path, null).body.get("data");
    }
  }

  String name() {
    return "test_" + id().replace("-", "").substring(0, 16);
  }

  @Test
  void registrationProfileAndRevocableSessions() throws Exception {
    var first = new Client();
    String name = name(), account = first.register(name);
    first.login(name);
    var second = new Client();
    second.login(name);
    assertEquals(
        409,
        first.send(
                "POST",
                "/auth/register",
                map("username", name, "email", "other@example.com", "password", PASSWORD))
            .status);
    assertEquals(
        400,
        first.send(
                "POST",
                "/auth/register",
                map("username", name(), "email", "bad@example.com", "password", "short"))
            .status);
    assertEquals(
        200,
        first.send("PATCH", "/profile", map("displayName", "Test Person", "bio", "About me"))
            .status);
    var profile = new Client().send("GET", "/users/" + name, null);
    assertEquals("Test Person", profile.data().get("displayName"));
    assertFalse(profile.data().containsKey("email"));
    assertFalse(profile.data().containsKey("emailVerified"));
    assertEquals(503, first.send("POST", "/auth/resend-verification", map()).status);
    assertEquals(
        503,
        first.send("POST", "/auth/forgot-password", map("email", name + "@example.com")).status);
    var changed =
        first.send(
            "POST",
            "/auth/change-password",
            map("currentPassword", PASSWORD, "newPassword", "new-strong-password-456"));
    assertEquals(200, changed.status);
    assertEquals(401, second.send("GET", "/profile", null).status);
    assertEquals(200, first.send("GET", "/profile", null).status);
    assertEquals(200, first.send("POST", "/auth/logout", map()).status);
    assertEquals(401, first.send("GET", "/profile", null).status);
    assertEquals(
        401,
        first.send("POST", "/auth/login", map("identifier", name, "password", PASSWORD)).status);
    assertEquals(
        200,
        first.send(
                "POST",
                "/auth/login",
                map("identifier", name + "@example.com", "password", "new-strong-password-456"))
            .status);
    assertFalse(
        w.db
            .queryForObject(
                "SELECT password_hash FROM accounts WHERE id=?", String.class, uuid(account))
            .contains(PASSWORD));
  }

  @Test
  void verificationAndResetTokensAreHashedExpiringSingleUseAndRevokeSessions() throws Exception {
    var client = new Client();
    String name = name(), account = client.register(name);
    client.login(name);
    String verify = AccountPasswords.token();
    w.db.update(
        "INSERT INTO"
            + " account_tokens(token_hash,account_id,kind,expires_at)VALUES(?,?,'verify',now()+interval"
            + " '1 hour')",
        hash(verify),
        uuid(account));
    assertEquals(200, client.send("POST", "/auth/verify-email", map("token", verify)).status);
    assertEquals(400, client.send("POST", "/auth/verify-email", map("token", verify)).status);
    assertEquals(true, client.send("GET", "/profile", null).data().get("emailVerified"));
    String reset = AccountPasswords.token();
    w.db.update(
        "INSERT INTO"
            + " account_tokens(token_hash,account_id,kind,expires_at)VALUES(?,?,'reset',now()-interval"
            + " '1 second')",
        hash(reset),
        uuid(account));
    assertEquals(
        400,
        client.send(
                "POST",
                "/auth/reset-password",
                map("token", reset, "password", "another-password-789"))
            .status);
    w.db.update(
        "UPDATE account_tokens SET expires_at=now()+interval '1 hour' WHERE token_hash=?",
        hash(reset));
    assertEquals(
        200,
        client.send(
                "POST",
                "/auth/reset-password",
                map("token", reset, "password", "another-password-789"))
            .status);
    assertEquals(401, client.send("GET", "/profile", null).status);
    assertEquals(
        400,
        client.send(
                "POST",
                "/auth/reset-password",
                map("token", reset, "password", "another-password-789"))
            .status);
    assertEquals(
        200,
        client.send(
                "POST", "/auth/login", map("identifier", name, "password", "another-password-789"))
            .status);
  }

  @Test
  void projectAuthorizationCoversEveryChildRouteAndFriendMembership() throws Exception {
    var owner = new Client();
    String ownerName = name(), ownerId = owner.register(ownerName);
    owner.login(ownerName);
    var other = new Client();
    String otherName = name(), otherId = other.register(otherName);
    other.login(otherName);
    var stranger = new Client();
    String strangerName = name();
    stranger.register(strangerName);
    stranger.login(strangerName);
    var guest = new Client();
    String legacy = guest.project(), project = owner.project();
    assertEquals(
        "private", owner.send("GET", "/projects/" + project, null).data().get("visibility"));
    assertEquals(
        "legacy_local", guest.send("GET", "/projects/" + legacy, null).data().get("visibility"));
    assertEquals(200, owner.send("GET", "/projects/" + legacy, null).status);
    assertTrue(
        ((List<?>) owner.rawData("/projects?scope=legacy"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(legacy)));
    assertFalse(
        ((List<?>) owner.rawData("/projects"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(legacy)));
    String random = id();
    for (String route :
        List.of(
            "",
            "/revisions",
            "/revisions/" + random,
            "/revisions/" + random + "/analysis",
            "/revisions/" + random + "/graph",
            "/revisions/" + random + "/layout",
            "/changes/" + random,
            "/test-suites/" + random,
            "/jobs/" + random,
            "/runs/" + random,
            "/comparisons/" + random,
            "/artifacts/" + random)) {
      assertEquals(403, other.send("GET", "/projects/" + project + route, null).status, route);
      assertEquals(401, guest.send("GET", "/projects/" + project + route, null).status, route);
    }
    for (String route :
        List.of(
            "/revisions",
            "/imports",
            "/import-previews",
            "/changes",
            "/head",
            "/test-suites",
            "/compilations",
            "/runs",
            "/comparisons",
            "/exports",
            "/jobs/" + random + "/cancel",
            "/runs/" + random + "/input"))
      assertEquals(403, other.send("POST", "/projects/" + project + route, map()).status, route);
    assertEquals(
        409,
        owner.send(
                "POST",
                "/projects/" + project + "/members",
                map("username", otherName, "role", "editor"))
            .status);
    var invite = owner.send("POST", "/friend-requests", map("username", otherName));
    String requestId = invite.data().get("id").toString();
    assertEquals(
        403, stranger.send("POST", "/friend-requests/" + requestId + "/accept", map()).status);
    assertEquals(
        403, owner.send("POST", "/friend-requests/" + requestId + "/accept", map()).status);
    assertEquals(
        200, other.send("POST", "/friend-requests/" + requestId + "/accept", map()).status);
    assertEquals(
        200,
        owner.send(
                "POST",
                "/projects/" + project + "/members",
                map("username", otherName, "role", "editor"))
            .status);
    assertEquals(true, other.send("GET", "/projects/" + project, null).data().get("canEdit"));
    assertEquals(
        403,
        other.send("PATCH", "/projects/" + project + "/access", map("visibility", "public"))
            .status);
    assertEquals(
        200,
        owner.send(
                "POST",
                "/projects/" + project + "/members",
                map("username", otherName, "role", "viewer"))
            .status);
    assertEquals(403, other.send("POST", "/projects/" + project + "/runs", map()).status);
    assertEquals(
        200,
        owner.send("PATCH", "/projects/" + project + "/access", map("visibility", "public"))
            .status);
    assertEquals(200, guest.send("GET", "/projects/" + project, null).status);
    assertFalse(
        ((List<?>) stranger.rawData("/projects"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(project)));
    assertEquals(404, stranger.send("GET", "/projects?before=" + project, null).status);
    assertTrue(
        ((List<?>) stranger.rawData("/users/" + ownerName + "/projects"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(project)));
    assertTrue(
        ((List<?>) other.rawData("/projects"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(project)));
    assertEquals(401, guest.send("POST", "/projects/" + project + "/runs", map()).status);
    assertEquals(403, stranger.send("POST", "/projects/" + project + "/runs", map()).status);
    assertEquals(
        200, owner.send("DELETE", "/projects/" + project + "/members/" + otherId, null).status);
    assertFalse(
        ((List<?>) other.rawData("/projects"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(project)));
    assertEquals(200, other.send("GET", "/projects/" + project, null).status);
    assertEquals(200, owner.send("DELETE", "/friends/" + otherId, null).status);
    assertFalse(
        ((List<?>) owner.rawData("/friends"))
            .stream().anyMatch(p -> ((Map<?, ?>) p).get("id").equals(otherId)));
    assertNotEquals(ownerId, otherId);
  }

  @Test
  void passwordsHaveIndependentSaltsAndCsrfIsStillMandatory() throws Exception {
    String first = AccountPasswords.encode(PASSWORD), second = AccountPasswords.encode(PASSWORD);
    assertNotEquals(first, second);
    assertTrue(AccountPasswords.matches(PASSWORD, first));
    assertFalse(AccountPasswords.matches("wrong", first));
    var client = new Client();
    client.csrf = null;
    assertEquals(
        403,
        client.send("POST", "/auth/login", map("identifier", "x", "password", PASSWORD)).status);
  }

  @Test
  void configuredDeliveryStoresOnlyHashedLinkAndDeliveryFailureNeverReportsSuccess()
      throws Exception {
    var client = new Client();
    String name = name(), account = client.register(name);
    client.login(name);
    org.mockito.Mockito.when(mail.available()).thenReturn(true);
    var delivered = new ArrayList<String>();
    org.mockito.Mockito.doAnswer(
            call -> {
              delivered.add(call.getArgument(2));
              return null;
            })
        .when(mail)
        .send(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.eq("verify"),
            org.mockito.ArgumentMatchers.anyString());
    var sent = client.send("POST", "/auth/resend-verification", map());
    assertEquals(200, sent.status);
    assertEquals(true, sent.data().get("sent"));
    assertEquals(1, delivered.size());
    String token = delivered.getFirst();
    assertEquals(
        hash(token),
        w.db.queryForObject(
            "SELECT token_hash FROM account_tokens WHERE account_id=?",
            String.class,
            uuid(account)));
    assertFalse(sent.body.toString().contains(token));
    org.mockito.Mockito.doThrow(AccountMail.unavailable())
        .when(mail)
        .send(
            org.mockito.ArgumentMatchers.anyString(),
            org.mockito.ArgumentMatchers.eq("verify"),
            org.mockito.ArgumentMatchers.anyString());
    assertEquals(503, client.send("POST", "/auth/resend-verification", map()).status);
    assertEquals(
        hash(token),
        w.db.queryForObject(
            "SELECT token_hash FROM account_tokens WHERE account_id=?",
            String.class,
            uuid(account)));
    assertEquals(200, client.send("POST", "/auth/verify-email", map("token", token)).status);
  }

  @Test
  void loginCannotBindOldPasswordToNewCredentialGeneration() throws Exception {
    for (boolean reset : List.of(false, true)) {
      var owner = new Client();
      String name = name(), account = owner.register(name);
      owner.login(name);
      var stale = new Client();
      var checked = new java.util.concurrent.CountDownLatch(1);
      var release = new java.util.concurrent.CountDownLatch(1);
      org.mockito.Mockito.doAnswer(
              call -> {
                var request = call.getArgument(0, jakarta.servlet.http.HttpServletRequest.class);
                if (request.getRequestURI().endsWith("/auth/login")) {
                  checked.countDown();
                  assertTrue(release.await(15, java.util.concurrent.TimeUnit.SECONDS));
                }
                return call.callRealMethod();
              })
          .when(accounts)
          .signIn(
              org.mockito.ArgumentMatchers.any(),
              org.mockito.ArgumentMatchers.eq(account),
              org.mockito.ArgumentMatchers.anyInt());
      try (var executor = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
        var login =
            executor.submit(
                () ->
                    stale.send(
                        "POST", "/auth/login", map("identifier", name, "password", PASSWORD)));
        try {
          assertTrue(checked.await(10, java.util.concurrent.TimeUnit.SECONDS));
          rotatePassword(owner, account, reset);
        } finally {
          release.countDown();
        }
        assertEquals(401, login.get(15, java.util.concurrent.TimeUnit.SECONDS).status);
        assertEquals(401, stale.send("GET", "/profile", null).status);
      }
    }
  }

  void rotatePassword(Client owner, String account, boolean reset) throws Exception {
    if (reset) {
      String token = AccountPasswords.token();
      w.db.update(
          "INSERT INTO"
              + " account_tokens(token_hash,account_id,kind,expires_at)VALUES(?,?,'reset',now()+interval"
              + " '1 hour')",
          hash(token),
          uuid(account));
      assertEquals(
          200,
          owner.send(
                  "POST",
                  "/auth/reset-password",
                  map("token", token, "password", "changed-password-456"))
              .status);
    } else {
      assertEquals(
          200,
          owner.send(
                  "POST",
                  "/auth/change-password",
                  map("currentPassword", PASSWORD, "newPassword", "changed-password-456"))
              .status);
    }
  }

  @Test
  void delayedSmtpCannotResurrectResetTokenAfterPasswordRotation() throws Exception {
    for (boolean reset : List.of(false, true)) {
      org.mockito.Mockito.when(mail.available()).thenReturn(false);
      var owner = new Client();
      String name = name(), account = owner.register(name);
      owner.login(name);
      org.mockito.Mockito.when(mail.available()).thenReturn(true);
      var entered = new java.util.concurrent.CountDownLatch(1);
      var release = new java.util.concurrent.CountDownLatch(1);
      var delivered = new java.util.concurrent.atomic.AtomicReference<String>();
      org.mockito.Mockito.doAnswer(
              call -> {
                delivered.set(call.getArgument(2));
                entered.countDown();
                assertTrue(release.await(15, java.util.concurrent.TimeUnit.SECONDS));
                return null;
              })
          .when(mail)
          .send(
              org.mockito.ArgumentMatchers.eq(name + "@example.com"),
              org.mockito.ArgumentMatchers.eq("reset"),
              org.mockito.ArgumentMatchers.anyString());
      try (var executor = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
        var issue =
            executor.submit(
                () ->
                    owner.send(
                        "POST", "/auth/forgot-password", map("email", name + "@example.com")));
        try {
          assertTrue(entered.await(10, java.util.concurrent.TimeUnit.SECONDS));
          // A separate HTTP client changes credentials while the SMTP request remains blocked.
          var rotating = new Client();
          rotating.login(name);
          rotatePassword(rotating, account, reset);
        } finally {
          release.countDown();
        }
        assertEquals(409, issue.get(15, java.util.concurrent.TimeUnit.SECONDS).status);
        assertEquals(
            0,
            w.db.queryForObject(
                "SELECT count(*) FROM account_tokens WHERE account_id=?",
                Integer.class,
                uuid(account)));
        assertEquals(
            400,
            new Client()
                .send(
                    "POST",
                    "/auth/reset-password",
                    map("token", delivered.get(), "password", "must-not-work-password"))
                .status);
      }
    }
  }

  @Test
  void viewersEditorsAndPublicAccountsCanExportReadableSourceWithoutMutation() throws Exception {
    var owner = new Client();
    String ownerName = name();
    owner.register(ownerName);
    owner.login(ownerName);
    var member = new Client();
    String memberName = name(), memberId = member.register(memberName);
    member.login(memberName);
    var publicViewer = new Client();
    String publicName = name();
    publicViewer.register(publicName);
    publicViewer.login(publicName);
    String project = owner.project();
    var revision =
        owner.send(
            "POST",
            "/projects/" + project + "/revisions",
            map(
                "expectedHeadRevisionId",
                "empty",
                "files",
                List.of(map("path", "notes.txt", "content", "actual export content")),
                "intent",
                "semantic_edit"));
    assertEquals(201, revision.status, revision.body.toString());
    String revisionId = revision.data().get("id").toString();
    w.db.update(
        "INSERT INTO project_members(project_id,account_id,role)VALUES(?,?,'viewer')",
        uuid(project),
        uuid(memberId));
    assertEquals(
        403,
        publicViewer.send(
                "POST", "/projects/" + project + "/exports", map("revisionId", revisionId))
            .status);
    for (String role : List.of("viewer", "editor")) {
      w.db.update(
          "UPDATE project_members SET role=? WHERE project_id=? AND account_id=?",
          role,
          uuid(project),
          uuid(memberId));
      exportAndCheck(member, project, revisionId);
    }
    assertEquals(
        200,
        owner.send("PATCH", "/projects/" + project + "/access", map("visibility", "public"))
            .status);
    exportAndCheck(publicViewer, project, revisionId);
    exportAndCheck(new Client(), project, revisionId);
    assertEquals(
        revisionId, owner.send("GET", "/projects/" + project, null).data().get("headRevisionId"));
    assertEquals(
        0,
        w.db.queryForObject(
            "SELECT count(*) FROM jobs WHERE project_id=?", Integer.class, uuid(project)));
  }

  void exportAndCheck(Client client, String project, String revision) throws Exception {
    var exported =
        client.send(
            "POST",
            "/projects/" + project + "/exports",
            map("revisionId", revision, "paths", List.of("notes.txt")));
    assertEquals(201, exported.status, exported.body.toString());
    String url = exported.data().get("downloadUrl").toString();
    var download =
        client.http.send(
            HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + url)).GET().build(),
            HttpResponse.BodyHandlers.ofByteArray());
    assertEquals(200, download.statusCode());
    try (var zip =
        new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(download.body()))) {
      assertEquals("notes.txt", zip.getNextEntry().getName());
      assertEquals(
          "actual export content",
          new String(zip.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
      assertNull(zip.getNextEntry());
    }
  }
}
