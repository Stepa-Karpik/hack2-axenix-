package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.util.*;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.transaction.PlatformTransactionManager;

/** Exercises the real interceptor; DB fixtures are synthetic rows, never input Java execution. */
class HostedProjectAccessTest {
  final String project = id();
  final String owner = id();
  String actor;
  String role;
  String rowOwner;
  String visibility;
  JdbcTemplate db;
  Accounts accounts;
  Workspace workspace;
  HostingAccess hosted;

  @BeforeEach
  void setup() {
    rowOwner = owner;
    visibility = "private";
    db = mock(JdbcTemplate.class);
    workspace = new Workspace(db, mock(PlatformTransactionManager.class));
    accounts = mock(Accounts.class);
    when(accounts.actor(any())).thenAnswer(invocation -> actor);
    when(db.queryForList(
            eq("SELECT owner_id::text,visibility FROM projects WHERE id=?"), eq(uuid(project))))
        .thenAnswer(invocation -> List.of(map("owner_id", rowOwner, "visibility", visibility)));
    // Membership lookup binds both project and actor; a one-UUID varargs stub never matches it.
    when(db.queryForList(
            eq("SELECT role FROM project_members WHERE project_id=? AND account_id=?"),
            eq(uuid(project)),
            any(UUID.class)))
        .thenAnswer(invocation -> role == null ? List.of() : List.of(map("role", role)));
    hosted = new HostingAccess(true, HostingAccessTest.ORIGIN, true);
  }

  @Test
  void hostedCollectionAndArchivePreviewRejectGuestBeforeDbOrController() {
    for (String method : List.of("GET", "POST")) denied(401, method, "/api/v1/projects", hosted);
    denied(401, "POST", "/api/v1/archive-previews", hosted);
    verifyNoInteractions(db);
  }

  @Test
  void authenticatedCollectionAllowsDefaultButRejectsEveryLegacyParameter() {
    actor = owner;
    assertTrue(allowed("POST", "/api/v1/projects", hosted));
    var request = new MockHttpServletRequest("GET", "/api/v1/projects");
    request.addParameter("scope", "default", "legacy");
    ApiError error =
        assertThrows(
            ApiError.class,
            () -> boundary(hosted).preHandle(request, new MockHttpServletResponse(), new Object()));
    assertEquals(403, error.status);
    verifyNoInteractions(db);
  }

  @Test
  void everyLegacyProjectPathIsHiddenEvenFromAuthenticatedActor() {
    rowOwner = null;
    for (String current : Arrays.asList(null, owner, id())) {
      actor = current;
      for (String suffix :
          List.of(
              "",
              "/revisions",
              "/revisions/" + id() + "/download",
              "/archives/" + id(),
              "/jobs/" + id())) denied(404, "GET", path(suffix), hosted);
      for (String suffix :
          List.of(
              "/revisions",
              "/changes",
              "/imports",
              "/import-previews",
              "/archive-imports",
              "/archives",
              "/exports",
              "/runs",
              "/comparisons")) denied(404, "POST", path(suffix), hosted);
    }
  }

  @Test
  void publicReadsSurviveButGuestCannotMaterializeExportOrExecute() {
    visibility = "public";
    assertTrue(allowed("GET", path("/revisions"), hosted));
    assertTrue(allowed("GET", path("/artifacts/" + id()), hosted));
    for (String suffix :
        List.of(
            "/exports",
            "/archives",
            "/runs",
            "/comparisons",
            "/runs/" + id() + "/repeat",
            "/runs/" + id() + "/input",
            "/jobs/" + id() + "/cancel")) denied(401, "POST", path(suffix), hosted);
  }

  @Test
  void accountOwnedPrivatePublicAndMemberRulesRemainInForce() {
    denied(401, "GET", path(""), hosted);
    actor = id();
    denied(403, "GET", path(""), hosted);
    role = "viewer";
    assertTrue(allowed("GET", path(""), hosted));
    assertTrue(allowed("POST", path("/archives"), hosted));
    denied(403, "POST", path("/runs"), hosted);
    role = "editor";
    assertTrue(allowed("POST", path("/runs"), hosted));
    role = null;
    actor = owner;
    assertTrue(allowed("POST", path("/imports"), hosted));
    actor = id();
    visibility = "public";
    assertTrue(allowed("POST", path("/exports"), hosted));
    denied(403, "POST", path("/changes"), hosted);
  }

  @Test
  void localGuestCompatibilityAndPublicGuestExportRemainUnchanged() {
    var local = new HostingAccess(false, "unused", false);
    assertTrue(allowed("GET", "/api/v1/projects", local));
    assertTrue(allowed("POST", "/api/v1/projects", local));
    rowOwner = null;
    assertTrue(allowed("POST", path("/runs"), local));
    rowOwner = owner;
    visibility = "public";
    assertTrue(allowed("POST", path("/archives"), local));
  }

  @Test
  void sessionCapabilitiesReflectActualModeAndActor() {
    AccountMail mail = mock(AccountMail.class);
    for (boolean enabled : List.of(false, true)) {
      var policy = new HostingAccess(enabled, HostingAccessTest.ORIGIN, enabled);
      var real = spy(new Accounts(workspace, mail, policy));
      for (String current : Arrays.asList(null, owner)) {
        var request = new MockHttpServletRequest();
        doReturn(current).when(real).actor(request);
        if (current != null) doReturn(map("id", current)).when(real).user(current, true);
        var session = real.session(request);
        assertEquals(
            current == null ? enabled ? "anonymous" : "local_guest" : "authenticated",
            session.get("mode"));
        assertEquals(enabled ? null : "local", session.get("localOwnerId"));
        Map<?, ?> caps = (Map<?, ?>) session.get("capabilities");
        assertEquals(!enabled, caps.get("legacyGuestWorkspace"));
        assertEquals(!enabled || current != null, caps.get("projectCreation"));
        assertEquals(!enabled || current != null, caps.get("projectExport"));
        assertNotNull(session.get("csrfToken"));
      }
    }
  }

  ProjectAccess boundary(HostingAccess policy) {
    return new ProjectAccess(accounts, workspace, policy);
  }

  String path(String suffix) {
    return "/api/v1/projects/" + project + suffix;
  }

  boolean allowed(String method, String path, HostingAccess policy) {
    return boundary(policy)
        .preHandle(
            new MockHttpServletRequest(method, path), new MockHttpServletResponse(), new Object());
  }

  void denied(int status, String method, String path, HostingAccess policy) {
    ApiError error =
        assertThrows(ApiError.class, () -> allowed(method, path, policy), method + path);
    assertEquals(status, error.status, method + path);
  }
}
