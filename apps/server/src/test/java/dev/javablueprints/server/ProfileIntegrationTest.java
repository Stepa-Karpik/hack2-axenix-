package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {"jb.runner.enabled=false", "jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ProfileIntegrationTest {
  static final String SCHEMA = "jbprofiletest_" + UUID.randomUUID().toString().replace("-", "");

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  @Autowired Accounts accounts;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbprofiletest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  String account() {
    String actor = id();
    w.db.update(
        "INSERT INTO accounts(id,username,email,password_hash,display_name)VALUES(?::uuid,?,?,?,?)",
        actor,
        "u_" + actor.replace("-", "").substring(0, 20),
        actor + "@example.invalid",
        "unused-trusted-fixture",
        "Profile fixture");
    return actor;
  }

  String project(String owner, String visibility) {
    String p = id();
    w.db.update(
        "INSERT INTO projects(id,name,owner_id,visibility)VALUES(?::uuid,?,?::uuid,?)",
        p,
        "fixture-" + p,
        owner,
        visibility);
    return p;
  }

  Set<String> ids(Object value) {
    return new HashSet<>(
        ((List<Map<String, Object>>) value).stream().map(p -> p.get("id").toString()).toList());
  }

  void member(String p, String actor) {
    w.db.update(
        "INSERT INTO project_members(project_id,account_id,role)VALUES(?::uuid,?::uuid,'editor')",
        p,
        actor);
  }

  void event(String p, String actor, String revision) {
    w.db.update(
        "INSERT INTO"
            + " audit_events(project_id,event,entity_id,actor_id)VALUES(?::uuid,'head_changed',?::uuid,?::uuid)",
        p,
        revision,
        actor);
  }

  String revision(String p) {
    String revision = id();
    w.db.update(
        "INSERT INTO revisions(id,project_id,data)VALUES(?::uuid,?::uuid,?::jsonb)",
        revision,
        p,
        w.encode(map("origin", "edit")));
    return revision;
  }

  @Test
  void visibleProjectsPinsAndCursorRespectViewerAccess() {
    String owner = account(), viewer = account(), other = account();
    String priv = project(owner, "private"),
        pub = project(owner, "public"),
        shared = project(other, "private");
    member(shared, owner);
    member(priv, viewer);
    assertEquals(
        Set.of(priv, pub, shared), ids(accounts.projectPage(owner, owner, 100, null).get("items")));
    assertEquals(
        Set.of(priv, pub), ids(accounts.projectPage(owner, viewer, 100, null).get("items")));
    assertEquals(Set.of(pub), ids(accounts.projectPage(owner, null, 100, null).get("items")));
    accounts.savePins(owner, map("projectIds", List.of(priv, pub)));
    assertEquals(Set.of(pub), ids(accounts.pins(owner, null)));
    assertEquals(Set.of(priv, pub), ids(accounts.pins(owner, viewer)));
    assertThrows(
        ApiError.class, () -> accounts.savePins(owner, map("projectIds", List.of(shared))));
    assertEquals(2, accounts.pins(owner, owner).size());
    assertThrows(
        ApiError.class, () -> accounts.savePins(owner, map("projectIds", List.of(pub, pub))));
    assertThrows(
        ApiError.class,
        () ->
            accounts.savePins(
                owner, map("projectIds", List.of(pub, priv, shared, id(), id(), id(), id()))));
    var first = accounts.projectPage(owner, owner, 1, null);
    assertEquals(3, first.get("totalVisible"));
    assertNotNull(first.get("nextCursor"));
    var second = accounts.projectPage(owner, owner, 1, first.get("nextCursor").toString());
    assertTrue(Collections.disjoint(ids(first.get("items")), ids(second.get("items"))));
    assertThrows(ApiError.class, () -> accounts.projectPage(owner, owner, 1, "broken"));
    w.db.update(
        "DELETE FROM project_members WHERE project_id=?::uuid AND account_id=?::uuid",
        priv,
        viewer);
    assertEquals(Set.of(pub), ids(accounts.projectPage(owner, viewer, 100, null).get("items")));
    assertEquals(Set.of(pub), ids(accounts.pins(owner, viewer)));
  }

  @Test
  void activityCreditsActualActorAndFiltersBeforeAggregating() {
    String owner = account(), editor = account();
    String publicProject = project(owner, "public"), privateProject = project(owner, "private");
    member(publicProject, editor);
    String published = revision(publicProject), hidden = revision(privateProject);
    event(publicProject, editor, published);
    event(publicProject, editor, published);
    event(publicProject, null, revision(publicProject));
    event(privateProject, editor, hidden);
    var ownerOverview = accounts.overview(owner, owner, 20, null);
    assertEquals(0, ((Map<?, ?>) ownerOverview.get("contributions")).get("total"));
    var anonymous = accounts.overview(editor, null, 20, null);
    assertEquals(1, ((Map<?, ?>) anonymous.get("contributions")).get("total"));
    assertEquals(365, ((List<?>) ((Map<?, ?>) anonymous.get("contributions")).get("days")).size());
    assertFalse(anonymous.toString().contains(privateProject));
    assertFalse(anonymous.toString().contains(hidden));
    var authorized = accounts.overview(editor, owner, 20, null);
    assertEquals(2, ((Map<?, ?>) authorized.get("contributions")).get("total"));
  }

  @Test
  void actualMutualFriendshipsExposePublicIdentityOnly() {
    String target = account(), viewer = account(), common = account(), another = account();
    friend(target, common);
    friend(target, another);
    friend(viewer, common);
    var page = accounts.profileFriends(target, viewer, 1, 0);
    assertEquals(2, page.get("count"));
    assertEquals(1, page.get("mutualCount"));
    assertEquals(1, page.get("nextOffset"));
    assertFalse(page.toString().contains("email"));
    assertFalse(page.toString().contains("password"));
    assertEquals(0, accounts.profileFriends(target, null, 20, 0).get("mutualCount"));
  }

  @Test
  void actualCasCreditsEditorOnceAcrossIdempotentReplay() {
    String owner = account(), editor = account(), p = project(owner, "public"), r = revision(p);
    member(p, editor);
    revision(p);
    var request = new org.springframework.mock.web.MockHttpServletRequest();
    request.setAttribute("accountId", editor);
    org.springframework.web.context.request.RequestContextHolder.setRequestAttributes(
        new org.springframework.web.context.request.ServletRequestAttributes(request));
    try {
      String key = id();
      var payload = map("revision", r);
      for (int i = 0; i < 2; i++)
        w.idem(
            "profile-fixture:" + p,
            key,
            payload,
            200,
            () -> {
              w.cas(p, "empty", r);
              return map("revision", r);
            });
      assertEquals(
          1,
          w.db.queryForObject(
              "SELECT count(*) FROM audit_events WHERE project_id=?::uuid AND actor_id=?::uuid",
              Integer.class,
              p,
              editor));
      assertEquals(
          1,
          ((Map<?, ?>) accounts.overview(editor, null, 20, null).get("contributions"))
              .get("total"));
      assertEquals(
          0,
          ((Map<?, ?>) accounts.overview(owner, null, 20, null).get("contributions")).get("total"));
    } finally {
      org.springframework.web.context.request.RequestContextHolder.resetRequestAttributes();
    }
  }

  void friend(String a, String b) {
    w.db.update(
        "INSERT INTO"
            + " friendships(first_id,second_id)VALUES(least(?::uuid,?::uuid),greatest(?::uuid,?::uuid))",
        a,
        b,
        a,
        b);
  }
}
