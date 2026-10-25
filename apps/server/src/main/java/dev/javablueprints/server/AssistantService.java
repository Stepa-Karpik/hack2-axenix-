package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import java.util.*;
import org.springframework.stereotype.Service;

@Service
class AssistantService {
  final Workspace w;
  final AssistantProvider provider;

  AssistantService(Workspace w, AssistantProvider provider) {
    this.w = w;
    this.provider = provider;
  }

  List<Map<String, Object>> list(String actor) {
    return w.db.queryForList(
        "SELECT id::text,title,updated_at AS \"updatedAt\" FROM assistant_conversations WHERE"
            + " account_id=? ORDER BY updated_at DESC LIMIT 50",
        uuid(actor));
  }

  void owned(String actor, String cid) {
    if (w.db
        .queryForList(
            "SELECT id FROM assistant_conversations WHERE id=? AND account_id=?",
            uuid(cid),
            uuid(actor))
        .isEmpty()) throw missing();
  }

  Map<String, Object> delete(String actor, String cid) {
    return w.tx.execute(
        tx -> {
          accountLock(actor);
          owned(actor, cid);
          var active =
              w.db.queryForList(
                  "SELECT account_id FROM assistant_usage WHERE account_id=? AND busy_until>now()",
                  uuid(actor));
          if (!active.isEmpty())
            throw new ApiError(409, "ASSISTANT_BUSY", "Дождитесь ответа помощника");
          w.db.update(
              "DELETE FROM assistant_conversations WHERE id=? AND account_id=?",
              uuid(cid),
              uuid(actor));
          return map("deleted", true);
        });
  }

  Map<String, Object> create(String actor) {
    return w.tx.execute(
        tx -> {
          accountLock(actor);
          Integer count =
              w.db.queryForObject(
                  "SELECT count(*) FROM assistant_conversations WHERE account_id=?",
                  Integer.class,
                  uuid(actor));
          if (count >= 50)
            throw new ApiError(429, "ASSISTANT_HISTORY_LIMIT", "Достигнут лимит диалогов (50)");
          String cid = id();
          w.db.update(
              "INSERT INTO assistant_conversations(id,account_id) VALUES(?,?)",
              uuid(cid),
              uuid(actor));
          return conversation(actor, cid);
        });
  }

  Map<String, Object> conversation(String actor, String cid) {
    owned(actor, cid);
    var row =
        w.db.queryForMap(
            "SELECT id::text,title FROM assistant_conversations WHERE id=?", uuid(cid));
    var messages =
        w.db.queryForList(
            "SELECT id::text,role,content,created_at AS \"createdAt\" FROM assistant_messages WHERE"
                + " conversation_id=? ORDER BY created_at,id LIMIT 600",
            uuid(cid));
    for (var m : messages)
      m.put(
          "actions",
          w
              .db
              .queryForList(
                  "SELECT id::text,type,args::text,risk,label,description,status FROM"
                      + " assistant_actions WHERE message_id=? ORDER BY created_at,id",
                  uuid(m.get("id").toString()))
              .stream()
              .map(this::publicAction)
              .toList());
    row.put("messages", messages);
    return row;
  }

  Map<String, Object> publicAction(Map<String, Object> row) {
    var a = new LinkedHashMap<>(row);
    a.put("args", w.decode(row.get("args").toString()));
    a.remove("binding");
    a.remove("claimed_at");
    a.remove("result");
    return a;
  }

  void accountLock(String actor) {
    w.db.queryForObject("SELECT id FROM accounts WHERE id=? FOR UPDATE", UUID.class, uuid(actor));
  }

  String acquire(String actor, String cid) {
    return w.tx.execute(
        tx -> {
          accountLock(actor);
          owned(actor, cid);
          w.db.update(
              "INSERT INTO assistant_usage(account_id) VALUES(?) ON CONFLICT DO NOTHING",
              uuid(actor));
          String token = id();
          int changed =
              w.db.update(
                  "UPDATE assistant_usage SET busy_token=?,busy_until=now()+interval '65"
                      + " seconds',minute_count=CASE WHEN minute_start<now()-interval '1 minute'"
                      + " THEN 1 ELSE minute_count+1 END,minute_start=CASE WHEN"
                      + " minute_start<now()-interval '1 minute' THEN now() ELSE minute_start"
                      + " END,day_count=CASE WHEN day_start<current_date THEN 1 ELSE day_count+1"
                      + " END,day_start=current_date WHERE account_id=? AND (busy_until IS NULL OR"
                      + " busy_until<now()) AND (minute_start<now()-interval '1 minute' OR"
                      + " minute_count<6) AND (day_start<current_date OR day_count<100)",
                  uuid(token),
                  uuid(actor));
          if (changed != 1)
            throw new ApiError(
                429,
                "ASSISTANT_RATE_LIMIT",
                "Дождитесь ответа или попробуйте позже (6 запросов в минуту, 100 в день)");
          Integer count =
              w.db.queryForObject(
                  "SELECT count(*) FROM assistant_messages WHERE conversation_id=?",
                  Integer.class,
                  uuid(cid));
          if (count > 97)
            throw new ApiError(429, "ASSISTANT_MESSAGE_LIMIT", "Создайте новый диалог");
          return token;
        });
  }

  Map<String, Object> send(String actor, String cid, Map<String, Object> body) {
    ApiController.fields(body, "content", "context");
    String content = AssistantActions.text(body, "content", 8000).strip();
    if (body.get("context") != null && !(body.get("context") instanceof Map))
      throw AssistantActions.invalid();
    Map<String, Object> context =
        body.get("context") instanceof Map<?, ?> c ? (Map<String, Object>) c : map();
    Map<String, Object> facts = facts(actor, context);
    String token = acquire(actor, cid);
    try {
      String mid = id();
      w.tx.executeWithoutResult(
          tx -> {
            w.db.update(
                "INSERT INTO assistant_messages(id,conversation_id,role,content)"
                    + " VALUES(?,?,'user',?)",
                uuid(mid),
                uuid(cid),
                AssistantProvider.redact(content));
            w.db.update(
                "UPDATE assistant_conversations SET title=CASE WHEN title='Новый диалог' THEN ?"
                    + " ELSE title END,updated_at=now() WHERE id=?",
                AssistantProvider.redact(content)
                    .substring(0, Math.min(80, AssistantProvider.redact(content).length())),
                uuid(cid));
          });
      var history =
          w.db.queryForList(
              "SELECT role,content FROM (SELECT id,role,content,created_at FROM assistant_messages"
                  + " WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 14) h ORDER BY"
                  + " created_at,id",
              uuid(cid));
      // A bounded suffix prevents accumulated conversation content from exhausting provider
      // context.
      int remaining = 24000;
      var bounded = new ArrayList<Map<String, Object>>();
      for (int i = history.size() - 1; i >= 0; i--) {
        var m = history.get(i);
        String text = m.get("content").toString();
        if (text.length() > remaining) break;
        remaining -= text.length();
        bounded.addFirst(m);
      }
      var known = AssistantActions.knownRequest(content);
      var reply = known != null ? known : provider.complete(bounded, facts);
      w.tx.executeWithoutResult(
          tx -> {
            String answer = id();
            w.db.update(
                "INSERT INTO assistant_messages(id,conversation_id,role,content)"
                    + " VALUES(?,?,'assistant',?)",
                uuid(answer),
                uuid(cid),
                reply.content());
            for (var p : reply.actions()) {
              var args = new LinkedHashMap<>(p.args());
              var binding = binding(actor, p, facts);
              if (binding == null) continue;
              if (!AssistantActions.serverMutation(p.type()))
                for (String key :
                    List.of("projectId", "revisionId", "filePath", "methodId", "methodName"))
                  if (facts.containsKey(key)) args.put(key, facts.get(key));
              w.db.update(
                  "INSERT INTO"
                      + " assistant_actions(id,message_id,type,args,risk,label,description,binding)"
                      + " VALUES(?,?,?,?::jsonb,?,?,?,?::jsonb)",
                  uuid(id()),
                  uuid(answer),
                  p.type(),
                  w.encode(args),
                  p.risk(),
                  p.label(),
                  description(p, facts),
                  w.encode(binding));
            }
            w.db.update(
                "UPDATE assistant_conversations SET updated_at=now() WHERE id=?", uuid(cid));
          });
      return conversation(actor, cid);
    } catch (ApiError e) {
      receipt(cid, "Ответ не получен: помощник временно недоступен. Попробуйте позже.");
      throw e;
    } finally {
      w.db.update(
          "UPDATE assistant_usage SET busy_until=NULL,busy_token=NULL WHERE account_id=? AND"
              + " busy_token=?",
          uuid(actor),
          uuid(token));
    }
  }

  Map<String, Object> facts(String actor, Map<String, Object> context) {
    var facts =
        map(
            "testScope",
            "Whole program/version comparison via main and configured suite, not arbitrary method"
                + " unit tests",
            "sourceIncluded",
            false);
    for (String key : List.of("route", "filePath", "methodId", "methodName")) {
      Object value = context.get(key);
      if (value instanceof String s && s.length() <= 240)
        facts.put(key, AssistantProvider.redact(s));
    }
    if (context.get("projectId") instanceof String project) {
      var rows =
          w.db.queryForList(
              "SELECT"
                  + " p.id::text,p.name,p.head_revision_id::text,p.owner_id::text,p.visibility,p.updated_at::text"
                  + " FROM projects p WHERE p.id=? AND (p.owner_id=? OR p.visibility='public' OR"
                  + " EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=p.id AND"
                  + " m.account_id=?))",
              uuid(project),
              uuid(actor),
              uuid(actor));
      if (rows.isEmpty()) throw missing();
      var p = rows.getFirst();
      facts.put("projectId", p.get("id"));
      facts.put("revisionId", p.get("head_revision_id"));
      facts.put("projectName", AssistantProvider.redact(p.get("name").toString()));
      facts.put("projectOwner", actor.equals(p.get("owner_id")));
      facts.put("visibility", p.get("visibility"));
      facts.put("projectUpdatedAt", p.get("updated_at"));
      facts.put(
          "recentJobs",
          w.db.queryForList(
              "SELECT type,status,finished_at::text FROM jobs WHERE project_id=? AND"
                  + " (input->>'revisionId'=? OR input->>'candidateRevisionId'=? OR"
                  + " input->>'baseRevisionId'=?) ORDER BY created_at DESC LIMIT 3",
              uuid(project),
              p.get("head_revision_id"),
              p.get("head_revision_id"),
              p.get("head_revision_id")));
      String entry =
          context.get("entryPoint") instanceof String s
                  && s.matches("[A-Za-z_$][A-Za-z0-9_$.]{0,199}")
              ? s
              : null;
      var comparisons =
          w.db.queryForList(
              "SELECT c.id::text,c.data->>'outcome' AS outcome,c.data->'matched' AS"
                  + " matched,c.data->'total' AS total,c.data->'coverageComplete' AS"
                  + " \"coverageComplete\",c.data->>'baseRevisionId' AS"
                  + " \"baseRevisionId\",c.data->>'candidateRevisionId' AS"
                  + " \"candidateRevisionId\",s.data->>'entryPoint' AS"
                  + " \"entryPoint\",c.created_at::text AS \"createdAt\" FROM resources c JOIN"
                  + " resources s ON s.project_id=c.project_id AND"
                  + " s.id::text=c.data->>'suiteVersionId' AND s.kind='suite' WHERE c.project_id=?"
                  + " AND c.kind='comparison' AND (c.data->>'candidateRevisionId'=? OR"
                  + " c.data->>'baseRevisionId'=?) AND (?::text IS NULL OR s.data->>'entryPoint'=?)"
                  + " ORDER BY c.created_at DESC LIMIT 2",
              uuid(project),
              p.get("head_revision_id"),
              p.get("head_revision_id"),
              entry,
              entry);
      // PostgreSQL JSON scalar objects are converted to primitive values without loading outputs.
      for (var comparison : comparisons)
        for (String key : List.of("matched", "total", "coverageComplete")) {
          Object scalar = comparison.get(key);
          if (scalar != null) {
            String value = scalar.toString();
            comparison.put(
                key,
                key.equals("coverageComplete")
                    ? Boolean.parseBoolean(value)
                    : Integer.parseInt(value));
          }
        }
      facts.put("currentRevisionComparisons", comparisons);
      facts.put(
          "comparisonScope",
          "Recorded main entryPoint and whole-program suite only; no proof of arbitrary"
              + " selected-method unit tests");
    }
    return facts;
  }

  String description(AssistantActions.Proposal p, Map<String, Object> facts) {
    String project =
        Objects.toString(facts.get("projectName"), "")
            + " ("
            + Objects.toString(facts.get("projectId"), "не выбран")
            + ")";
    String selection =
        Objects.toString(facts.get("filePath"), "файл не выбран")
            + (facts.get("methodName") == null ? "" : " · " + facts.get("methodName"));
    return switch (p.type()) {
      case "set_visibility" ->
          "Проект "
              + project
              + ": видимость станет "
              + ("public".equals(p.args().get("visibility"))
                  ? "публичной. Содержимое станет доступно другим пользователям."
                  : "приватной.")
              + " Для подтверждения введите да.";
      case "pin_project" ->
          "Проект "
              + project
              + (Boolean.TRUE.equals(p.args().get("pinned"))
                  ? " будет закреплён в вашем профиле."
                  : " будет откреплён от вашего профиля.");
      case "update_profile" -> "Новое описание вашего профиля: «" + p.args().get("bio") + "».";
      case "run_tests" ->
          "Проект "
              + project
              + ", "
              + selection
              + ". Повторить сравнение всей программы на записанном наборе тестов. При отсутствии"
              + " параметров откроется настройка; метод отдельно не запускается.";
      case "workspace_action" -> "Проект " + project + ", " + selection + ". Действие: " + p.args().get("action") + ". Формы требуют заполнения; сохранение и остановка выполняются после подтверждения.";
      case "run_program" -> "Проект " + project + ", " + selection + ". Запустить программу с прежними параметрами или открыть настройки запуска.";
      case "optimize" ->
          "Проект "
              + project
              + ", "
              + selection
              + ". Подготовить предложение оптимизации выбранного метода; применение изменений"
              + " потребует проверки компиляции и тестов.";
      case "set_theme" -> "Применить палитру " + p.args().get("preset") + " к вашему интерфейсу.";
      case "navigate" -> "Открыть раздел " + p.args().get("route") + ".";
      case "show_panel" ->
          "Показать панель " + p.args().get("panel") + " в проекте " + project + ".";
      case "find_symbol" ->
          "Найти символ «" + p.args().get("query") + "» в проекте " + project + ".";
      case "guide" -> "Показать подсказки в интерфейсе: " + p.args().get("topic") + ".";
      case "explain" -> "Рассказать порядок действий: " + p.args().get("topic") + ".";
      default -> p.description();
    };
  }

  Map<String, Object> binding(
      String actor, AssistantActions.Proposal proposal, Map<String, Object> facts) {
    var result = map();
    String type = proposal.type();
    if (type.equals("update_profile")) {
      result.put(
          "bio",
          w.db.queryForObject("SELECT bio FROM accounts WHERE id=?", String.class, uuid(actor)));
      return result;
    }
    if (Set.of("set_visibility", "pin_project").contains(type)) {
      if (!Boolean.TRUE.equals(facts.get("projectOwner"))
          || !Objects.equals(proposal.args().get("projectId"), facts.get("projectId"))) return null;
    }
    if (Set.of("set_visibility", "pin_project", "run_tests", "run_program", "workspace_action", "optimize").contains(type)) {
      if (!facts.containsKey("projectId")) return null;
      result.put("projectId", facts.get("projectId"));
      result.put("revisionId", facts.get("revisionId"));
      result.put("updatedAt", facts.get("projectUpdatedAt"));
    }
    return result;
  }

  Map<String, Object> act(String actor, String cid, String aid, Map<String, Object> body) {
    ApiController.fields(body, "confirmation");
    owned(actor, cid);
    return w.tx.execute(
        tx -> {
          accountLock(actor);
          var rows =
              w.db.queryForList(
                  "SELECT"
                      + " a.id::text,a.type,a.args::text,a.risk,a.label,a.description,a.status,a.claimed_at,a.binding::text"
                      + " FROM assistant_actions a JOIN assistant_messages m ON m.id=a.message_id"
                      + " WHERE a.id=? AND m.conversation_id=? FOR UPDATE OF a",
                  uuid(aid),
                  uuid(cid));
          if (rows.isEmpty()) throw missing();
          var row = rows.getFirst();
          var pub = publicAction(row);
          if (row.get("claimed_at") != null || !row.get("status").equals("pending"))
            return map(
                "action",
                pub,
                "outcome",
                row.get("claimed_at") != null ? "already_claimed" : "cancelled");
          if (row.get("risk").equals("typed") && !"да".equals(body.get("confirmation")))
            throw new ApiError(
                400, "CONFIRMATION_REQUIRED", "Введите да для изменения видимости проекта");
          String type = row.get("type").toString();
          var args = w.decode(row.get("args").toString());
          var bind = w.decode(row.get("binding").toString());
          if (bind.get("projectId") != null) {
            var projects =
                w.db.queryForList(
                    "SELECT head_revision_id::text,owner_id::text,updated_at::text FROM projects"
                        + " WHERE id=? FOR UPDATE",
                    uuid(bind.get("projectId").toString()));
            if (projects.isEmpty()) throw missing();
            var p = projects.getFirst();
            if (!Objects.equals(bind.get("revisionId"), p.get("head_revision_id"))
                || !Objects.equals(bind.get("updatedAt"), p.get("updated_at"))) throw stale();
            if (AssistantActions.serverMutation(type) && !actor.equals(p.get("owner_id")))
              throw new ApiError(
                  403, "OWNER_REQUIRED", "Only project owner can confirm this action");
            if (!AssistantActions.serverMutation(type))
              facts(actor, map("projectId", bind.get("projectId")));
          }
          boolean server = AssistantActions.serverMutation(type);
          if (type.equals("set_visibility"))
            w.db.update(
                "UPDATE projects SET visibility=?,updated_at=now() WHERE id=? AND owner_id=?",
                args.get("visibility"),
                uuid(args.get("projectId").toString()),
                uuid(actor));
          if (type.equals("update_profile")) {
            String current =
                w.db.queryForObject(
                    "SELECT bio FROM accounts WHERE id=?", String.class, uuid(actor));
            if (!Objects.equals(current, bind.get("bio"))) throw stale();
            w.db.update("UPDATE accounts SET bio=? WHERE id=?", args.get("bio"), uuid(actor));
          }
          if (type.equals("pin_project")) {
            var pins =
                w.db.queryForList(
                    "SELECT project_id::text FROM profile_pins WHERE account_id=? ORDER BY"
                        + " position",
                    uuid(actor));
            var ids =
                new ArrayList<>(pins.stream().map(p -> p.get("project_id").toString()).toList());
            String project = args.get("projectId").toString();
            ids.remove(project);
            if (Boolean.TRUE.equals(args.get("pinned"))) ids.add(project);
            if (ids.size() > 6)
              throw new ApiError(400, "PIN_LIMIT", "Можно закрепить до шести проектов");
            w.db.update("DELETE FROM profile_pins WHERE account_id=?", uuid(actor));
            for (int i = 0; i < ids.size(); i++)
              w.db.update(
                  "INSERT INTO profile_pins(account_id,project_id,position) VALUES(?,?,?)",
                  uuid(actor),
                  uuid(ids.get(i)),
                  i);
          }
          w.db.update(
              "UPDATE assistant_actions SET claimed_at=now(),status=? WHERE id=?",
              server ? "completed" : "pending",
              uuid(aid));
          pub.put("status", server ? "completed" : "pending");
          if (server) {
            receipt(cid, "Действие подтверждено и выполнено сервером: " + row.get("label"));
            return map("action", pub);
          }
          return map("action", pub, "command", map("type", type, "args", args));
        });
  }

  Map<String, Object> result(String actor, String cid, String aid, Map<String, Object> body) {
    ApiController.fields(body, "ok", "message");
    if (!(body.get("ok") instanceof Boolean)) throw AssistantActions.invalid();
    String message = AssistantActions.text(body, "message", 2000);
    owned(actor, cid);
    return w.tx.execute(
        tx -> {
          var rows =
              w.db.queryForList(
                  "SELECT"
                      + " a.id::text,a.type,a.args::text,a.risk,a.label,a.description,a.status,a.claimed_at"
                      + " FROM assistant_actions a JOIN assistant_messages m ON m.id=a.message_id"
                      + " WHERE a.id=? AND m.conversation_id=? FOR UPDATE OF a",
                  uuid(aid),
                  uuid(cid));
          if (rows.isEmpty()) throw missing();
          var row = rows.getFirst();
          if (AssistantActions.serverMutation(row.get("type").toString())
              || row.get("claimed_at") == null) throw AssistantActions.invalid();
          if (row.get("status").equals("pending")) {
            String state = Boolean.TRUE.equals(body.get("ok")) ? "completed" : "cancelled";
            w.db.update(
                "UPDATE assistant_actions SET status=?,result=? WHERE id=?",
                state,
                AssistantProvider.redact(message),
                uuid(aid));
            row.put("status", state);
            receipt(
                cid,
                "Интерфейс сообщил результат действия (не подтверждение прохождения тестов): "
                    + AssistantProvider.redact(message));
          }
          return map("action", publicAction(row));
        });
  }

  Map<String, Object> cancel(String actor, String cid, String aid) {
    owned(actor, cid);
    return w.tx.execute(
        tx -> {
          accountLock(actor);
          var rows =
              w.db.queryForList(
                  "SELECT"
                      + " a.id::text,a.type,a.args::text,a.risk,a.label,a.description,a.status,a.claimed_at"
                      + " FROM assistant_actions a JOIN assistant_messages m ON m.id=a.message_id"
                      + " WHERE a.id=? AND m.conversation_id=? FOR UPDATE OF a",
                  uuid(aid),
                  uuid(cid));
          if (rows.isEmpty()) throw missing();
          var row = rows.getFirst();
          if (row.get("claimed_at") != null)
            return map("action", publicAction(row), "outcome", "already_claimed");
          if (row.get("status").equals("pending")) {
            w.db.update(
                "UPDATE assistant_actions SET status='cancelled' WHERE id=? AND claimed_at IS NULL"
                    + " AND status='pending'",
                uuid(aid));
            row.put("status", "cancelled");
            receipt(cid, "Пользователь отклонил предложение");
          }
          return map("action", publicAction(row));
        });
  }

  void receipt(String cid, String text) {
    w.db.update(
        "INSERT INTO assistant_messages(id,conversation_id,role,content) VALUES(?,?,'assistant',?)",
        uuid(id()),
        uuid(cid),
        text);
    w.db.update("UPDATE assistant_conversations SET updated_at=now() WHERE id=?", uuid(cid));
  }

  static ApiError stale() {
    return new ApiError(
        409, "ASSISTANT_ACTION_STALE", "Проект или профиль изменён. Запросите действие снова.");
  }
}
