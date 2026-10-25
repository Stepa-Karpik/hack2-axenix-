package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.web.context.request.*;

@Service
class Accounts {
  final Workspace w;
  final AccountMail mail;
  final HostingAccess hosting;
  final Map<String, Attempt> attempts = new ConcurrentHashMap<>();

  record Attempt(long window, int count) {}

  Accounts(Workspace w, AccountMail mail, HostingAccess hosting) {
    this.w = w;
    this.mail = mail;
    this.hosting = hosting;
  }

  void throttle(String action, String identity, int limit) {
    long now = System.currentTimeMillis();
    String key = hash(action + ":" + identity);
    if (attempts.size() > 10000)
      attempts.entrySet().removeIf(e -> now - e.getValue().window() > 900000);
    if (attempts.size() > 10000) throw new ApiError(429, "RATE_LIMITED", "Try again later");
    var result =
        attempts.compute(
            key,
            (k, v) ->
                v == null || now - v.window() > 900000
                    ? new Attempt(now, 1)
                    : new Attempt(v.window(), v.count() + 1));
    if (result.count() > limit) throw new ApiError(429, "RATE_LIMITED", "Try again in 15 minutes");
  }

  String actor(HttpServletRequest req) {
    var session = req.getSession(false);
    if (session == null || session.getAttribute("accountId") == null) return null;
    String id = session.getAttribute("accountId").toString();
    var rows = w.db.queryForList("SELECT auth_version FROM accounts WHERE id=?", uuid(id));
    if (rows.isEmpty()
        || !Objects.equals(
            rows.getFirst().get("auth_version"), session.getAttribute("authVersion"))) {
      session.removeAttribute("accountId");
      session.removeAttribute("authVersion");
      return null;
    }
    return id;
  }

  String actor() {
    var context = RequestContextHolder.getRequestAttributes();
    return context instanceof ServletRequestAttributes r ? actor(r.getRequest()) : null;
  }

  String require(HttpServletRequest req) {
    String id = actor(req);
    if (id == null) throw new ApiError(401, "AUTH_REQUIRED", "Sign in required");
    return id;
  }

  Map<String, Object> user(String id, boolean own) {
    var rows =
        w.db.queryForList(
            "SELECT a.id::text,a.username,a.email,a.email_verified,a.display_name,a.bio,a.auth_method,"
                + " av.version AS avatar_version FROM accounts a LEFT JOIN account_avatars av"
                + " ON av.account_id=a.id WHERE a.id=?",
            uuid(id));
    if (rows.isEmpty()) throw missing();
    var r = rows.getFirst();
    var result =
        map(
            "id",
            r.get("id"),
            "username",
            r.get("username"),
            "displayName",
            r.get("display_name"),
            "bio",
            r.get("bio"),
            "avatarUrl",
            r.get("avatar_version") == null ? null
                : "/api/v1/users/" + r.get("username") + "/avatar?v=" + r.get("avatar_version"));
    if (own) {
      result.put("authMethod", r.get("auth_method"));
      result.put("email", r.get("email"));
      result.put("emailVerified", r.get("email_verified"));
    }
    return result;
  }

  String byUsername(String name) {
    var rows =
        w.db.queryForList("SELECT id::text FROM accounts WHERE lower(username)=lower(?)", name);
    if (rows.isEmpty()) throw missing();
    return rows.getFirst().get("id").toString();
  }

  Map<String, Object> session(HttpServletRequest req) {
    var session = req.getSession(true);
    if (session.getAttribute("csrf") == null)
      session.setAttribute("csrf", AccountPasswords.token());
    String actor = actor(req);
    return map(
        "mode",
        actor == null ? (hosting.hosted() ? "anonymous" : "local_guest") : "authenticated",
        "csrfToken",
        session.getAttribute("csrf"),
        "localOwnerId",
        hosting.hosted() ? null : "local",
        "user",
        actor == null ? null : user(actor, true),
        "capabilities",
        map(
            "registration", true,
            "emailDelivery", mail.available(),
            "legacyGuestWorkspace", !hosting.hosted(),
            "projectCreation", hosting.projectCreation(actor),
            "projectExport", hosting.projectCreation(actor)));
  }

  void signIn(HttpServletRequest req, String account, int checkedVersion) {
    w.tx.executeWithoutResult(
        tx -> {
          // Bind only the credential generation actually checked. Password updates take this same
          // lock.
          Integer currentVersion =
              w.db.queryForObject(
                  "SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",
                  Integer.class,
                  uuid(account));
          if (!Objects.equals(currentVersion, checkedVersion))
            throw new ApiError(401, "INVALID_CREDENTIALS", "Credentials changed; sign in again");
          req.getSession(true);
          req.changeSessionId();
          var session = req.getSession();
          session.setAttribute("accountId", account);
          session.setAttribute("authVersion", checkedVersion);
          session.setAttribute("csrf", AccountPasswords.token());
        });
  }

  Map<String, Object> register(Map<String, Object> b, HttpServletRequest req) {
    throttle("register", req.getRemoteAddr(), 20);
    String name = str(b, "username").strip(),
        email = str(b, "email").strip().toLowerCase(Locale.ROOT);
    if (!name.matches("[A-Za-z0-9_]{3,32}"))
      throw new ApiError(
          400, "INVALID_USERNAME", "Username must contain 3..32 letters, digits or underscores");
    if (!AccountMail.validAddress(email))
      throw new ApiError(400, "INVALID_EMAIL", "Invalid email address");
    String password = AccountPasswords.encode(str(b, "password")), account = id();
    try {
      w.db.update(
          "INSERT INTO accounts(id,username,email,password_hash,display_name)VALUES(?,?,?,?,?)",
          uuid(account),
          name,
          email,
          password,
          name);
    } catch (DuplicateKeyException e) {
      throw new ApiError(409, "ACCOUNT_CONFLICT", "Username or email is already registered");
    }
    boolean delivered = false;
    try {
      issue(account, "verify");
      delivered = true;
    } catch (ApiError e) {
      if (!e.code.equals("SMTP_UNAVAILABLE")) throw e;
    }
    return map(
        "user",
        user(account, true),
        "verificationRequired",
        true,
        "emailDelivery",
        delivered,
        "emailError",
        delivered ? null : "SMTP_UNAVAILABLE");
  }

  Map<String, Object> login(Map<String, Object> b, HttpServletRequest req) {
    String identifier = str(b, "identifier").strip();
    throttle("login-ip", req.getRemoteAddr(), 60);
    throttle("login", identifier.toLowerCase(Locale.ROOT), 15);
    var rows =
        w.db.queryForList(
            "SELECT id::text,password_hash,auth_version FROM accounts WHERE"
                + " lower(username)=lower(?) OR lower(email)=lower(?)",
            identifier,
            identifier);
    String encoded =
        rows.isEmpty() || rows.getFirst().get("password_hash") == null
            ? DUMMY_PASSWORD : rows.getFirst().get("password_hash").toString();
    boolean valid = AccountPasswords.matches(str(b, "password"), encoded);
    if (rows.isEmpty() || rows.getFirst().get("password_hash") == null || !valid)
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid username/email or password");
    signIn(
        req,
        rows.getFirst().get("id").toString(),
        ((Number) rows.getFirst().get("auth_version")).intValue());
    return session(req);
  }

  private static final String DUMMY_PASSWORD = AccountPasswords.encode(AccountPasswords.token());

  void requirePasswordAccount(String account) {
    if ("github".equals(w.db.queryForObject("SELECT auth_method FROM accounts WHERE id=?", String.class, uuid(account))))
      throw new ApiError(409, "GITHUB_ONLY_ACCOUNT", "This account signs in through GitHub only");
  }

  void issue(String account, String kind) {
    requirePasswordAccount(account);
    if (!mail.available()) throw AccountMail.unavailable();
    String token = AccountPasswords.token();
    var own = user(account, true);
    Integer issuedVersion =
        w.db.queryForObject(
            "SELECT auth_version FROM accounts WHERE id=?", Integer.class, uuid(account));
    // Preserve existing usable links if SMTP fails; commit the new token only after acceptance.
    mail.send(own.get("email").toString(), kind, token);
    w.tx.executeWithoutResult(
        tx -> {
          // SMTP performs no DB locking. An intervening password change invalidates this issuance.
          Integer currentVersion =
              w.db.queryForObject(
                  "SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",
                  Integer.class,
                  uuid(account));
          if (!Objects.equals(currentVersion, issuedVersion))
            throw new ApiError(
                409, "CREDENTIALS_CHANGED", "Credentials changed; request a new link");
          w.db.update(
              "DELETE FROM account_tokens WHERE account_id=? AND kind=?", uuid(account), kind);
          w.db.update(
              "INSERT INTO account_tokens(token_hash,account_id,kind,expires_at)VALUES(?,?,?,?)",
              hash(token),
              uuid(account),
              kind,
              java.sql.Timestamp.from(
                  Instant.now().plusSeconds(kind.equals("verify") ? 86400 : 3600)));
        });
  }

  void consume(String raw, String kind, String password, HttpServletRequest req) {
    throttle("token", req.getRemoteAddr(), 30);
    if (raw.length() != 43) throw new ApiError(400, "TOKEN_INVALID", "Link is invalid or expired");
    String encoded = kind.equals("reset") ? AccountPasswords.encode(password) : null;
    w.tx.executeWithoutResult(
        tx -> {
          var candidates =
              w.db.queryForList(
                  "SELECT account_id::text FROM account_tokens WHERE token_hash=? AND kind=?",
                  hash(raw),
                  kind);
          if (candidates.isEmpty())
            throw new ApiError(400, "TOKEN_INVALID", "Link is invalid or expired");
          String account = candidates.getFirst().get("account_id").toString();
          requirePasswordAccount(account);
          // Use the same account-then-token lock order as issuance and password changes.
          w.db.queryForObject(
              "SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",
              Integer.class,
              uuid(account));
          var rows =
              w.db.queryForList(
                  "DELETE FROM account_tokens WHERE token_hash=? AND kind=? AND expires_at>now()"
                      + " RETURNING account_id::text",
                  hash(raw),
                  kind);
          if (rows.isEmpty())
            throw new ApiError(400, "TOKEN_INVALID", "Link is invalid or expired");
          if (kind.equals("verify"))
            w.db.update("UPDATE accounts SET email_verified=true WHERE id=?", uuid(account));
          else {
            w.db.update(
                "UPDATE accounts SET password_hash=?,auth_version=auth_version+1 WHERE id=?",
                encoded,
                uuid(account));
            w.db.update("DELETE FROM account_tokens WHERE account_id=?", uuid(account));
          }
        });
  }

  void changePassword(Map<String, Object> b, HttpServletRequest req) {
    String account = require(req);
    requirePasswordAccount(account);
    throttle("change-password", account, 15);
    String encoded = AccountPasswords.encode(str(b, "newPassword"));
    Integer changedVersion =
        w.tx.execute(
            tx -> {
              String current =
                  w.db.queryForObject(
                      "SELECT password_hash FROM accounts WHERE id=? FOR UPDATE",
                      String.class,
                      uuid(account));
              if (!AccountPasswords.matches(str(b, "currentPassword"), current))
                throw new ApiError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
              Integer version =
                  w.db.queryForObject(
                      "UPDATE accounts SET password_hash=?,auth_version=auth_version+1 WHERE id=?"
                          + " RETURNING auth_version",
                      Integer.class,
                      encoded,
                      uuid(account));
              w.db.update("DELETE FROM account_tokens WHERE account_id=?", uuid(account));
              return version;
            });
    signIn(req, account, changedVersion);
  }

  static final String PROFILE_PROJECT_SCOPE =
      "(p.owner_id=?::uuid OR EXISTS(SELECT 1 FROM project_members tm WHERE tm.project_id=p.id AND"
          + " tm.account_id=?::uuid)) AND (p.visibility='public' OR p.owner_id=?::uuid OR"
          + " EXISTS(SELECT 1 FROM project_members vm WHERE vm.project_id=p.id AND"
          + " vm.account_id=?::uuid))";
  static final String VIEWER_SCOPE =
      "(p.visibility='public' OR p.owner_id=?::uuid OR EXISTS(SELECT 1 FROM project_members vm"
          + " WHERE vm.project_id=p.id AND vm.account_id=?::uuid))";

  Map<String, Object> projectPage(String target, String viewer, int limit, String before) {
    if (limit < 1 || limit > 100)
      throw new ApiError(400, "INVALID_REQUEST", "Project page limit must be 1..100");
    String cursorId = null, cursorTime = null;
    if (before != null)
      try {
        String[] parts =
            new String(
                    Base64.getUrlDecoder().decode(before), java.nio.charset.StandardCharsets.UTF_8)
                .split("\\n", -1);
        if (parts.length != 2) throw new IllegalArgumentException();
        cursorTime = Instant.parse(parts[0]).toString();
        cursorId = uuid(parts[1]).toString();
      } catch (Exception e) {
        throw new ApiError(400, "INVALID_REQUEST", "Invalid project cursor");
      }
    Integer total =
        w.db.queryForObject(
            "SELECT count(*) FROM projects p WHERE " + PROFILE_PROJECT_SCOPE,
            Integer.class,
            target,
            target,
            viewer,
            viewer);
    var rows =
        w.db.queryForList(
            "SELECT p.id::text,p.updated_at FROM projects p WHERE "
                + PROFILE_PROJECT_SCOPE
                + " AND (?::uuid IS NULL OR (p.updated_at,p.id)<(?::timestamptz,?::uuid)) ORDER BY"
                + " p.updated_at DESC,p.id DESC LIMIT ?",
            target,
            target,
            viewer,
            viewer,
            cursorId,
            cursorTime,
            cursorId,
            limit + 1);
    boolean more = rows.size() > limit;
    var page = rows.subList(0, Math.min(rows.size(), limit));
    String next = null;
    if (more) {
      var last = page.getLast();
      String time = ((java.sql.Timestamp) last.get("updated_at")).toInstant().toString();
      next =
          Base64.getUrlEncoder()
              .withoutPadding()
              .encodeToString(
                  (time + "\n" + last.get("id")).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    return map(
        "items",
        page.stream().map(row -> w.project(row.get("id").toString())).toList(),
        "nextCursor",
        next,
        "totalVisible",
        total);
  }

  List<Map<String, Object>> pins(String target, String viewer) {
    return w
        .db
        .queryForList(
            "SELECT p.id::text FROM profile_pins pin JOIN projects p ON p.id=pin.project_id WHERE"
                + " pin.account_id=?::uuid AND p.owner_id=?::uuid AND "
                + VIEWER_SCOPE
                + " ORDER BY pin.position",
            target,
            target,
            viewer,
            viewer)
        .stream()
        .map(row -> w.project(row.get("id").toString()))
        .toList();
  }

  Map<String, Object> savePins(String actor, Map<String, Object> body) {
    ApiController.fields(body, "projectIds");
    if (!(body.get("projectIds") instanceof List<?> values)
        || values.size() > 6
        || values.stream().anyMatch(v -> !(v instanceof String))
        || new HashSet<>(values).size() != values.size())
      throw new ApiError(400, "INVALID_REQUEST", "Choose up to six distinct owned projects");
    var ids = values.stream().map(v -> uuid(v.toString())).toList();
    return w.tx.execute(
        tx -> {
          w.db.queryForObject(
              "SELECT id FROM accounts WHERE id=? FOR UPDATE", UUID.class, uuid(actor));
          for (UUID project : ids) {
            var owners =
                w.db.queryForList(
                    "SELECT owner_id::text FROM projects WHERE id=? FOR UPDATE", project);
            if (owners.isEmpty() || !actor.equals(owners.getFirst().get("owner_id")))
              throw new ApiError(403, "PIN_OWNER_REQUIRED", "Only your own projects can be pinned");
          }
          w.db.update("DELETE FROM profile_pins WHERE account_id=?", uuid(actor));
          for (int index = 0; index < ids.size(); index++)
            w.db.update(
                "INSERT INTO profile_pins(account_id,project_id,position)VALUES(?,?,?)",
                uuid(actor),
                ids.get(index),
                index);
          return map("items", pins(actor, actor));
        });
  }

  Map<String, Object> profileFriends(String target, String viewer, int limit, int offset) {
    if (limit < 1 || limit > 100 || offset < 0 || offset > 100000)
      throw new ApiError(400, "INVALID_REQUEST", "Invalid friend page");
    String people =
        "SELECT CASE WHEN first_id=?::uuid THEN second_id ELSE first_id END AS id FROM friendships"
            + " WHERE first_id=?::uuid OR second_id=?::uuid";
    Integer total =
        w.db.queryForObject(
            "SELECT count(*) FROM friendships WHERE first_id=?::uuid OR second_id=?::uuid",
            Integer.class,
            target,
            target);
    Integer mutual =
        viewer == null
            ? 0
            : w.db.queryForObject(
                "SELECT count(*) FROM (" + people + ") theirs JOIN (" + people + ") mine USING(id)",
                Integer.class,
                target,
                target,
                target,
                viewer,
                viewer,
                viewer);
    var rows =
        w.db.queryForList(
            "SELECT friend.id::text FROM ("
                + people
                + ") friend JOIN accounts u ON u.id=friend.id ORDER BY lower(u.username),u.id LIMIT"
                + " ? OFFSET ?",
            target,
            target,
            target,
            limit,
            offset);
    return map(
        "items",
        rows.stream().map(row -> user(row.get("id").toString(), false)).toList(),
        "count",
        total,
        "mutualCount",
        mutual,
        "nextOffset",
        offset + rows.size() < total ? offset + rows.size() : null);
  }

  Map<String, Object> overview(String target, String viewer, int limit, String before) {
    LocalDate today = LocalDate.now(ZoneOffset.UTC), from = today.minusDays(364);
    Instant start = from.atStartOfDay(ZoneOffset.UTC).toInstant(),
        end = today.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant();
    String scope =
        " FROM audit_events e JOIN revisions r ON r.project_id=e.project_id AND r.id=e.entity_id"
            + " JOIN projects p ON p.id=r.project_id WHERE e.actor_id=?::uuid AND"
            + " e.event='head_changed' AND e.created_at>=? AND e.created_at<? AND "
            + VIEWER_SCOPE;
    var counts =
        w.db.queryForList(
            "SELECT (e.created_at AT TIME ZONE 'UTC')::date::text AS day,count(DISTINCT"
                + " e.entity_id) AS count"
                + scope
                + " GROUP BY day ORDER BY day",
            target,
            java.sql.Timestamp.from(start),
            java.sql.Timestamp.from(end),
            viewer,
            viewer);
    var byDay = new HashMap<String, Integer>();
    for (var row : counts)
      byDay.put(row.get("day").toString(), ((Number) row.get("count")).intValue());
    var days = new ArrayList<Map<String, Object>>();
    int total = 0;
    for (LocalDate day = from; !day.isAfter(today); day = day.plusDays(1)) {
      int n = byDay.getOrDefault(day.toString(), 0);
      total += n;
      days.add(map("date", day.toString(), "count", n));
    }
    var activity =
        w
            .db
            .queryForList(
                "SELECT r.id::text AS revision_id,p.id::text AS project_id,p.name AS"
                    + " project_name,e.created_at,r.data->>'origin' AS origin"
                    + scope
                    + " ORDER BY e.created_at DESC,e.id DESC LIMIT 20",
                target,
                java.sql.Timestamp.from(start),
                java.sql.Timestamp.from(end),
                viewer,
                viewer)
            .stream()
            .map(
                row ->
                    map(
                        "revisionId",
                        row.get("revision_id"),
                        "projectId",
                        row.get("project_id"),
                        "projectName",
                        row.get("project_name"),
                        "createdAt",
                        ((java.sql.Timestamp) row.get("created_at")).toInstant().toString(),
                        "origin",
                        row.get("origin")))
            .toList();
    var friends = profileFriends(target, viewer, 1, 0);
    return map(
        "user",
        user(target, false),
        "projects",
        projectPage(target, viewer, limit, before),
        "pinnedProjects",
        pins(target, viewer),
        "friends",
        map("count", friends.get("count"), "mutualCount", friends.get("mutualCount")),
        "contributions",
        map(
            "from",
            from.toString(),
            "to",
            today.toString(),
            "timezone",
            "UTC",
            "days",
            days,
            "total",
            total,
            "attribution",
            "head_change_actor"),
        "activity",
        activity,
        "tracking",
        map("legacyUnattributed", true));
  }
}
