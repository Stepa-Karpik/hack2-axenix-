package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
class AccountController {
  final Accounts a;
  final Workspace w;

  AccountController(Accounts a, Workspace w) {
    this.a = a;
    this.w = w;
  }

  Map<String, Object> ok(Object data) {
    return map("data", data, "meta", map("requestId", id()));
  }

  @PostMapping("/auth/register")
  ResponseEntity<?> register(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    return ResponseEntity.status(201).body(ok(a.register(b, r)));
  }

  @PostMapping("/auth/login")
  Object login(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    return ok(a.login(b, r));
  }

  @PostMapping("/auth/logout")
  Object logout(HttpServletRequest r) {
    var s = r.getSession(false);
    if (s != null) s.invalidate();
    return ok(a.session(r));
  }

  @PostMapping("/auth/verify-email")
  Object verify(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    a.consume(str(b, "token"), "verify", null, r);
    return ok(map("verified", true));
  }

  @PostMapping("/auth/reset-password")
  Object reset(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    a.consume(str(b, "token"), "reset", str(b, "password"), r);
    return ok(map("reset", true));
  }

  @PostMapping("/auth/resend-verification")
  Object resend(HttpServletRequest r) {
    String actor = a.require(r);
    a.throttle("resend", actor, 5);
    if (Boolean.TRUE.equals(a.user(actor, true).get("emailVerified")))
      return ok(map("alreadyVerified", true, "sent", false));
    a.issue(actor, "verify");
    return ok(map("sent", true));
  }

  @PostMapping("/auth/forgot-password")
  Object forgot(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    a.throttle("forgot", r.getRemoteAddr(), 10);
    String email = str(b, "email").strip().toLowerCase(Locale.ROOT);
    if (!a.mail.available()) throw AccountMail.unavailable();
    var rows = w.db.queryForList("SELECT id::text FROM accounts WHERE lower(email)=?", email);
    if (!rows.isEmpty()) a.issue(rows.getFirst().get("id").toString(), "reset");
    return ok(
        map(
            "accepted",
            true,
            "message",
            "If this email is registered, a reset link has been sent"));
  }

  @PostMapping("/auth/change-password")
  Object password(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    a.changePassword(b, r);
    return ok(map("changed", true, "csrfToken", a.session(r).get("csrfToken")));
  }

  @GetMapping("/profile")
  Object profile(HttpServletRequest r) {
    return ok(a.user(a.require(r), true));
  }

  @PatchMapping("/profile")
  Object profile(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    String actor = a.require(r);
    ApiController.fields(b, "displayName", "bio");
    var current = a.user(actor, true);
    Object name = b.getOrDefault("displayName", current.get("displayName")),
        bio = b.getOrDefault("bio", current.get("bio"));
    if (!(name instanceof String n)
        || n.isBlank()
        || n.length() > 80
        || !(bio instanceof String text)
        || text.length() > 1000)
      throw new ApiError(
          400, "INVALID_REQUEST", "Display name must contain 1..80 characters; bio up to 1000");
    w.db.update("UPDATE accounts SET display_name=?,bio=? WHERE id=?", name, bio, uuid(actor));
    return ok(a.user(actor, true));
  }

  @GetMapping("/users")
  Object users(@RequestParam(defaultValue = "") String q) {
    if (q.length() > 80) throw new ApiError(400, "INVALID_REQUEST", "Search is too long");
    if (q.isBlank()) return ok(List.of());
    return ok(
        w
            .db
            .queryForList(
                "SELECT id::text FROM accounts WHERE position(lower(?) in lower(username))>0 ORDER"
                    + " BY username LIMIT 20",
                q.strip())
            .stream()
            .map(row -> a.user(row.get("id").toString(), false))
            .toList());
  }

  @GetMapping("/users/{username}")
  Object user(@PathVariable String username) {
    return ok(a.user(a.byUsername(username), false));
  }

  @GetMapping("/users/{username}/projects")
  Object publicProjects(@PathVariable String username) {
    return ok(
        w
            .db
            .queryForList(
                "SELECT id::text FROM projects WHERE owner_id=? AND visibility='public' ORDER BY"
                    + " created_at DESC LIMIT 100",
                uuid(a.byUsername(username)))
            .stream()
            .map(row -> w.project(row.get("id").toString()))
            .toList());
  }

  @GetMapping("/friends")
  Object friends(HttpServletRequest r) {
    String actor = a.require(r);
    return ok(
        w
            .db
            .queryForList(
                "SELECT CASE WHEN first_id=? THEN second_id ELSE first_id END::text AS id FROM"
                    + " friendships WHERE first_id=? OR second_id=? ORDER BY created_at",
                uuid(actor),
                uuid(actor),
                uuid(actor))
            .stream()
            .map(row -> a.user(row.get("id").toString(), false))
            .toList());
  }

  Map<String, Object> request(Map<String, Object> row) {
    return map(
        "id",
        row.get("id").toString(),
        "from",
        a.user(row.get("sender_id").toString(), false),
        "to",
        a.user(row.get("recipient_id").toString(), false),
        "createdAt",
        row.get("created_at").toString());
  }

  @GetMapping("/friend-requests")
  Object requests(HttpServletRequest r) {
    String actor = a.require(r);
    var incoming = new ArrayList<>();
    var outgoing = new ArrayList<>();
    for (var row :
        w.db.queryForList(
            "SELECT * FROM friend_requests WHERE sender_id=? OR recipient_id=? ORDER BY created_at",
            uuid(actor),
            uuid(actor)))
      (row.get("recipient_id").toString().equals(actor) ? incoming : outgoing).add(request(row));
    return ok(map("incoming", incoming, "outgoing", outgoing));
  }

  @PostMapping("/friend-requests")
  Object invite(@RequestBody Map<String, Object> b, HttpServletRequest r) {
    String actor = a.require(r), recipient = a.byUsername(str(b, "username"));
    a.throttle("friend-request", actor, 30);
    if (actor.equals(recipient)) throw new ApiError(400, "INVALID_REQUEST", "Cannot add yourself");
    if (friends(actor, recipient)) throw new ApiError(409, "ALREADY_FRIENDS", "Already friends");
    String id = id();
    try {
      w.db.update(
          "INSERT INTO friend_requests(id,sender_id,recipient_id)VALUES(?,?,?)",
          uuid(id),
          uuid(actor),
          uuid(recipient));
    } catch (DuplicateKeyException e) {
      throw new ApiError(409, "REQUEST_EXISTS", "A friend request already exists");
    }
    return ok(
        request(
            w.db.queryForList("SELECT * FROM friend_requests WHERE id=?", uuid(id)).getFirst()));
  }

  boolean friends(String first, String second) {
    return Boolean.TRUE.equals(
        w.db.queryForObject(
            "SELECT EXISTS(SELECT 1 FROM friendships WHERE first_id=least(?::uuid,?::uuid) AND"
                + " second_id=greatest(?::uuid,?::uuid))",
            Boolean.class,
            first,
            second,
            first,
            second));
  }

  @PostMapping("/friend-requests/{id}/{action}")
  Object respond(@PathVariable String id, @PathVariable String action, HttpServletRequest r) {
    String actor = a.require(r);
    w.tx.executeWithoutResult(
        tx -> {
          var rows =
              w.db.queryForList("SELECT * FROM friend_requests WHERE id=? FOR UPDATE", uuid(id));
          if (rows.isEmpty()) throw missing();
          var row = rows.getFirst();
          String sender = row.get("sender_id").toString(),
              recipient = row.get("recipient_id").toString();
          if (!Set.of("accept", "decline", "cancel").contains(action))
            throw new ApiError(400, "INVALID_REQUEST", "Unknown request action");
          if (!actor.equals(action.equals("cancel") ? sender : recipient))
            throw new ApiError(403, "ACCESS_DENIED", "Friend request access denied");
          if (action.equals("accept"))
            w.db.update(
                "INSERT INTO"
                    + " friendships(first_id,second_id)VALUES(least(?::uuid,?::uuid),greatest(?::uuid,?::uuid))"
                    + " ON CONFLICT DO NOTHING",
                sender,
                recipient,
                sender,
                recipient);
          w.db.update("DELETE FROM friend_requests WHERE id=?", uuid(id));
        });
    return ok(map("status", action));
  }

  @DeleteMapping("/friends/{userId}")
  Object removeFriend(@PathVariable String userId, HttpServletRequest r) {
    String actor = a.require(r);
    w.db.update(
        "DELETE FROM friendships WHERE first_id=least(?::uuid,?::uuid) AND"
            + " second_id=greatest(?::uuid,?::uuid)",
        actor,
        userId,
        actor,
        userId);
    return ok(map("removed", true));
  }

  void owner(String project, HttpServletRequest r) {
    String actor = a.require(r);
    if (!Objects.equals(
        w.db.queryForObject(
            "SELECT owner_id::text FROM projects WHERE id=?", String.class, uuid(project)),
        actor))
      throw new ApiError(403, "OWNER_REQUIRED", "Only the project owner can manage access");
  }

  @GetMapping("/projects/{project}/access")
  Object access(@PathVariable String project, HttpServletRequest r) {
    owner(project, r);
    return ok(w.project(project));
  }

  @PatchMapping("/projects/{project}/access")
  Object access(
      @PathVariable String project, @RequestBody Map<String, Object> b, HttpServletRequest r) {
    owner(project, r);
    String visibility = str(b, "visibility");
    if (!Set.of("private", "public").contains(visibility))
      throw new ApiError(400, "INVALID_REQUEST", "Visibility must be private or public");
    w.db.update(
        "UPDATE projects SET visibility=?,updated_at=now() WHERE id=?", visibility, uuid(project));
    return ok(w.project(project));
  }

  @GetMapping("/projects/{project}/members")
  Object members(@PathVariable String project, HttpServletRequest r) {
    owner(project, r);
    return ok(
        w
            .db
            .queryForList(
                "SELECT account_id::text,role FROM project_members WHERE project_id=?",
                uuid(project))
            .stream()
            .map(
                row ->
                    map(
                        "user",
                        a.user(row.get("account_id").toString(), false),
                        "role",
                        row.get("role")))
            .toList());
  }

  @PostMapping("/projects/{project}/members")
  Object member(
      @PathVariable String project, @RequestBody Map<String, Object> b, HttpServletRequest r) {
    owner(project, r);
    String actor = a.require(r), member = a.byUsername(str(b, "username")), role = str(b, "role");
    if (!Set.of("editor", "viewer").contains(role))
      throw new ApiError(400, "INVALID_REQUEST", "Role must be editor or viewer");
    if (!friends(actor, member))
      throw new ApiError(409, "FRIEND_REQUIRED", "Add this user as a friend before inviting them");
    w.db.update(
        "INSERT INTO project_members(project_id,account_id,role)VALUES(?,?,?) ON"
            + " CONFLICT(project_id,account_id) DO UPDATE SET role=excluded.role",
        uuid(project),
        uuid(member),
        role);
    return ok(map("user", a.user(member, false), "role", role));
  }

  @DeleteMapping("/projects/{project}/members/{userId}")
  Object removeMember(
      @PathVariable String project, @PathVariable String userId, HttpServletRequest r) {
    owner(project, r);
    w.db.update(
        "DELETE FROM project_members WHERE project_id=? AND account_id=?",
        uuid(project),
        uuid(userId));
    return ok(map("removed", true));
  }
}

@RestControllerAdvice
class AccountErrors {
  @ExceptionHandler(ApiError.class)
  ResponseEntity<?> error(ApiError e) {
    return ResponseEntity.status(e.status)
        .body(
            map(
                "error",
                map("code", e.code, "message", e.getMessage(), "details", List.of()),
                "meta",
                map("requestId", id())));
  }

  @ExceptionHandler({
    IllegalArgumentException.class,
    ClassCastException.class,
    org.springframework.http.converter.HttpMessageNotReadableException.class
  })
  ResponseEntity<?> bad(Exception e) {
    return error(new ApiError(400, "INVALID_REQUEST", "Invalid request shape or value"));
  }
}
