package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

@SpringBootTest(properties = {"jb.runner.enabled=false", "jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AssistantIntegrationTest {
  static final String SCHEMA = "jbassistanttest_" + UUID.randomUUID().toString().replace("-", "");

  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }

  @Autowired Workspace w;
  @Autowired AssistantService service;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AssistantProvider provider;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;

  @AfterAll
  void cleanup() {
    assertTrue(SCHEMA.matches("jbassistanttest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  String account() {
    String actor = id();
    w.db.update(
        "INSERT INTO accounts(id,username,email,password_hash,display_name) VALUES(?,?,?,?,?)",
        uuid(actor),
        "a_" + actor.replace("-", "").substring(0, 20),
        actor + "@example.invalid",
        "unused-fixture",
        "Assistant fixture");
    return actor;
  }

  String project(String actor) {
    String pid = id();
    w.db.update(
        "INSERT INTO projects(id,name,owner_id,visibility) VALUES(?,?,?,'private')",
        uuid(pid),
        "Assistant fixture",
        uuid(actor));
    return pid;
  }

  String conversation(String actor) {
    return service.create(actor).get("id").toString();
  }

  Map<String, Object> action(Map<String, Object> c) {
    return ((List<Map<String, Object>>) c.get("messages"))
        .stream()
            .filter(m -> m.get("role").equals("assistant"))
            .map(m -> (List<Map<String, Object>>) m.get("actions"))
            .flatMap(List::stream)
            .findFirst()
            .orElseThrow();
  }

  void response(String type, Map<String, Object> args) {
    when(provider.complete(anyList(), anyMap()))
        .thenReturn(
            new AssistantProvider.Reply(
                "Предлагаю действие", List.of(AssistantActions.validate(type, args))));
  }

  @Test
  void durableHistoryIsAccountIsolatedAndIgnoresClientPassStatus() {
    String owner = account(), other = account(), pid = project(owner), cid = conversation(owner);
    response("set_theme", map("preset", "oled"));
    var answer =
        service.send(
            owner,
            cid,
            map(
                "content",
                "Привет",
                "context",
                map("projectId", pid, "testsPassed", true, "source", "secret")));
    assertEquals(2, ((List<?>) answer.get("messages")).size());
    assertEquals(1, service.list(owner).size());
    assertTrue(service.list(other).isEmpty());
    assertThrows(ApiError.class, () -> service.conversation(other, cid));
    assertThrows(ApiError.class, () -> service.facts(other, map("projectId", pid)));
    var facts =
        service.facts(owner, map("projectId", pid, "testsPassed", true, "source", "secret"));
    assertFalse(facts.containsKey("testsPassed"));
    assertFalse(facts.containsKey("source"));
    assertEquals(false, facts.get("sourceIncluded"));
    var reloaded = new AssistantService(w, provider);
    assertEquals(answer.get("messages"), reloaded.conversation(owner, cid).get("messages"));
  }

  @Test
  void visibilityRequiresExactConfirmationAndDoesNotRerun() {
    String actor = account(), pid = project(actor), cid = conversation(actor);
    response("set_visibility", map("projectId", pid, "visibility", "public"));
    var a =
        action(
            service.send(
                actor, cid, map("content", "Опубликуй", "context", map("projectId", pid))));
    String aid = a.get("id").toString();
    assertThrows(ApiError.class, () -> service.act(actor, cid, aid, map("confirmation", "Да")));
    assertThrows(ApiError.class, () -> service.act(actor, cid, aid, map()));
    assertEquals(
        "completed",
        ((Map<?, ?>) service.act(actor, cid, aid, map("confirmation", "да")).get("action"))
            .get("status"));
    assertEquals(
        "public",
        w.db.queryForObject("SELECT visibility FROM projects WHERE id=?", String.class, uuid(pid)));
    w.db.update("UPDATE projects SET visibility='private' WHERE id=?", uuid(pid));
    assertFalse(service.act(actor, cid, aid, map("confirmation", "да")).containsKey("command"));
    assertEquals(
        "private",
        w.db.queryForObject("SELECT visibility FROM projects WHERE id=?", String.class, uuid(pid)));
    assertThrows(
        ApiError.class,
        () -> service.result(actor, cid, aid, map("ok", true, "message", "forged")));
  }

  @Test
  void staleProjectAndCrossAccountConfirmationsFail() {
    String actor = account(), other = account(), pid = project(actor), cid = conversation(actor);
    response("set_visibility", map("projectId", pid, "visibility", "public"));
    var a =
        action(
            service.send(
                actor, cid, map("content", "Видимость", "context", map("projectId", pid))));
    String aid = a.get("id").toString();
    assertThrows(ApiError.class, () -> service.act(other, cid, aid, map("confirmation", "да")));
    w.db.update("UPDATE projects SET updated_at=now()+interval '1 second' WHERE id=?", uuid(pid));
    assertEquals(
        "ASSISTANT_ACTION_STALE",
        assertThrows(ApiError.class, () -> service.act(actor, cid, aid, map("confirmation", "да")))
            .code);
  }

  @Test
  void executableWorkspaceCommandsAreBoundToProjectAndClaimedOnce() {
    for(String type:List.of("run_program","workspace_action")) {
      String actor=account(),other=account(),pid=project(actor),cid=conversation(actor);
      response(type,type.equals("workspace_action")?map("action","create_file"):map());
      var a=action(service.send(actor,cid,map("content","Действие","context",map("projectId",pid))));
      String aid=a.get("id").toString();
      assertThrows(ApiError.class,()->service.act(other,cid,aid,map()));
      var claimed=service.act(actor,cid,aid,map());
      assertEquals(type,((Map<?,?>)claimed.get("command")).get("type"));
      assertFalse(service.act(actor,cid,aid,map()).containsKey("command"));
      var next=action(service.send(actor,conversation(actor),map("content","Ещё","context",map("projectId",pid))));
      String nextCid=w.db.queryForObject("SELECT m.conversation_id::text FROM assistant_actions a JOIN assistant_messages m ON m.id=a.message_id WHERE a.id=?",String.class,uuid(next.get("id").toString()));
      w.db.update("UPDATE projects SET updated_at=now()+interval '1 second' WHERE id=?",uuid(pid));
      assertEquals("ASSISTANT_ACTION_STALE",assertThrows(ApiError.class,()->service.act(actor,nextCid,next.get("id").toString(),map())).code);
    }
  }

  @Test
  void uiCommandsAreClaimedOnceAndCannotForgeServerMutations() {
    String actor = account(), cid = conversation(actor);
    response("set_theme", map("preset", "oled"));
    String aid = action(service.send(actor, cid, map("content", "Тема"))).get("id").toString();
    assertThrows(
        ApiError.class, () -> service.result(actor, cid, aid, map("ok", true, "message", "done")));
    assertTrue(service.act(actor, cid, aid, map()).containsKey("command"));
    assertFalse(service.act(actor, cid, aid, map()).containsKey("command"));
    assertEquals(
        "completed",
        ((Map<?, ?>)
                service
                    .result(actor, cid, aid, map("ok", true, "message", "Тема применена"))
                    .get("action"))
            .get("status"));
    assertFalse(service.act(actor, cid, aid, map()).containsKey("command"));
  }

  @Test
  void accountLeaseAndRateLimitAreDurable() {
    String actor = account(), cid = conversation(actor);
    String token = service.acquire(actor, cid);
    assertThrows(ApiError.class, () -> new AssistantService(w, provider).acquire(actor, cid));
    w.db.update(
        "UPDATE assistant_usage SET busy_until=NULL,minute_count=6 WHERE account_id=?",
        uuid(actor));
    assertThrows(ApiError.class, () -> service.acquire(actor, cid));
    w.db.update(
        "UPDATE assistant_usage SET minute_start=now()-interval '2 minutes',day_count=100 WHERE"
            + " account_id=?",
        uuid(actor));
    assertThrows(ApiError.class, () -> service.acquire(actor, cid));
    assertNotNull(token);
  }

  @Test
  void declinedProposalIsOwnedDurableAndCannotExecute() {
    String actor = account(), other = account(), cid = conversation(actor);
    response("set_theme", map("preset", "oled"));
    String aid =
        action(service.send(actor, cid, map("content", "Другая тема"))).get("id").toString();
    assertThrows(ApiError.class, () -> service.cancel(other, cid, aid));
    assertEquals(
        "cancelled", ((Map<?, ?>) service.cancel(actor, cid, aid).get("action")).get("status"));
    assertFalse(service.act(actor, cid, aid, map()).containsKey("command"));
    service.cancel(actor, cid, aid);
    var history = (List<Map<String, Object>>) service.conversation(actor, cid).get("messages");
    assertEquals(
        1,
        history.stream()
            .filter(m -> "Пользователь отклонил предложение".equals(m.get("content")))
            .count());
    assertThrows(
        ApiError.class,
        () -> service.result(actor, cid, aid, map("ok", true, "message", "forged")));
  }

  @Test
  void alreadyClaimedProposalCannotBeCancelledOrReexecuted() {
    String actor = account(), cid = conversation(actor);
    response("set_theme", map("preset", "oled"));
    String aid = action(service.send(actor, cid, map("content", "Тема"))).get("id").toString();
    assertTrue(service.act(actor, cid, aid, map()).containsKey("command"));
    assertEquals("already_claimed", service.act(actor, cid, aid, map()).get("outcome"));
    var decline = service.cancel(actor, cid, aid);
    assertEquals("already_claimed", decline.get("outcome"));
    assertEquals("pending", ((Map<?, ?>) decline.get("action")).get("status"));
    assertEquals(2, ((List<?>) service.conversation(actor, cid).get("messages")).size());
  }

  @Test
  void providerFailuresReleaseLeaseAndStoreOnlySafeReceipt() {
    String actor = account(), cid = conversation(actor);
    when(provider.complete(anyList(), anyMap())).thenThrow(AssistantProvider.unavailable());
    assertThrows(ApiError.class, () -> service.send(actor, cid, map("content", "Помоги")));
    assertNull(
        w.db.queryForObject(
            "SELECT busy_until FROM assistant_usage WHERE account_id=?",
            Object.class,
            uuid(actor)));
    assertEquals(2, ((List<?>) service.conversation(actor, cid).get("messages")).size());
  }

  @Test
  void reportsAreScopedToCurrentRevisionAndRecordedMainWithoutOutputs() {
    String actor = account(), pid = project(actor), rev = id(), old = id(), suite = id();
    w.db.update(
        "INSERT INTO revisions(id,project_id,data) VALUES(?,?,?::jsonb)",
        uuid(rev),
        uuid(pid),
        "{}");
    w.db.update("UPDATE projects SET head_revision_id=? WHERE id=?", uuid(rev), uuid(pid));
    w.putResource(
        pid,
        suite,
        "suite",
        map("entryPoint", "demo.Main", "cases", List.of(map("stdinUtf8", "private-test-input"))));
    w.putResource(
        pid,
        id(),
        "comparison",
        map(
            "baseRevisionId",
            old,
            "candidateRevisionId",
            old,
            "suiteVersionId",
            suite,
            "outcome",
            "matched_on_tests",
            "matched",
            99,
            "total",
            99,
            "coverageComplete",
            true));
    w.putResource(
        pid,
        id(),
        "comparison",
        map(
            "baseRevisionId",
            old,
            "candidateRevisionId",
            rev,
            "suiteVersionId",
            suite,
            "outcome",
            "mismatch",
            "matched",
            2,
            "total",
            3,
            "coverageComplete",
            true,
            "testResults",
            List.of(map("stdout", "private-test-output"))));
    var facts = service.facts(actor, map("projectId", pid));
    var reports = (List<Map<String, Object>>) facts.get("currentRevisionComparisons");
    assertEquals(1, reports.size());
    assertEquals("mismatch", reports.getFirst().get("outcome"));
    assertEquals(2, reports.getFirst().get("matched"));
    assertEquals("demo.Main", reports.getFirst().get("entryPoint"));
    assertFalse(w.encode(facts).contains("private-test"));
    assertTrue(
        ((List<?>)
                service
                    .facts(actor, map("projectId", pid, "entryPoint", "other.Main"))
                    .get("currentRevisionComparisons"))
            .isEmpty());
  }

  @Test
  void deleteRequiresOwnershipCascadesAndRejectsInFlight() {
    String actor = account(), other = account(), cid = conversation(actor);
    response("set_theme", map("preset", "oled"));
    service.send(actor, cid, map("content", "Палитра"));
    assertThrows(ApiError.class, () -> service.delete(other, cid));
    String lease = service.acquire(actor, cid);
    assertThrows(ApiError.class, () -> service.delete(actor, cid));
    w.db.update("UPDATE assistant_usage SET busy_until=NULL WHERE account_id=?", uuid(actor));
    assertEquals(true, service.delete(actor, cid).get("deleted"));
    assertThrows(ApiError.class, () -> service.conversation(actor, cid));
    assertEquals(
        0,
        w.db.queryForObject(
            "SELECT count(*) FROM assistant_messages WHERE conversation_id=?",
            Integer.class,
            uuid(cid)));
    assertNotNull(lease);
  }

  @Test
  void profileIsBoundToReviewedBioAndPinRequiresOwnedProject() {
    String actor = account(),
        other = account(),
        cid = conversation(actor),
        pid = project(actor),
        foreign = project(other);
    response("update_profile", map("bio", "Новое описание"));
    var profile = action(service.send(actor, cid, map("content", "Описание")));
    assertTrue(profile.get("description").toString().contains("Новое описание"));
    w.db.update("UPDATE accounts SET bio='edited elsewhere' WHERE id=?", uuid(actor));
    assertThrows(
        ApiError.class, () -> service.act(actor, cid, profile.get("id").toString(), map()));
    response("pin_project", map("projectId", foreign, "pinned", true));
    var invalid =
        service.send(actor, cid, map("content", "Закрепить", "context", map("projectId", pid)));
    var messages = (List<Map<String, Object>>) invalid.get("messages");
    assertTrue(((List<?>) messages.getLast().get("actions")).isEmpty());
    response("pin_project", map("projectId", pid, "pinned", true));
    String aid =
        actionForLast(
                service.send(
                    actor,
                    cid,
                    map("content", "Закрепить мой проект", "context", map("projectId", pid))))
            .get("id")
            .toString();
    service.act(actor, cid, aid, map());
    assertEquals(
        1,
        w.db.queryForObject(
            "SELECT count(*) FROM profile_pins WHERE account_id=? AND project_id=?",
            Integer.class,
            uuid(actor),
            uuid(pid)));
  }

  Map<String, Object> actionForLast(Map<String, Object> c) {
    var messages = (List<Map<String, Object>>) c.get("messages");
    return ((List<Map<String, Object>>) messages.getLast().get("actions")).getFirst();
  }
}
