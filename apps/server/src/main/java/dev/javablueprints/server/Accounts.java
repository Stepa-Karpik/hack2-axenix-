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
  final Map<String, Attempt> attempts = new ConcurrentHashMap<>();

  record Attempt(long window, int count) {}

  Accounts(Workspace w, AccountMail mail) {
    this.w = w;
    this.mail = mail;
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
            "SELECT id::text,username,email,email_verified,display_name,bio FROM accounts WHERE"
                + " id=?",
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
            r.get("bio"));
    if (own) {
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
        actor == null ? "local_guest" : "authenticated",
        "csrfToken",
        session.getAttribute("csrf"),
        "localOwnerId",
        "local",
        "user",
        actor == null ? null : user(actor, true),
        "capabilities",
        map("registration", true, "emailDelivery", mail.available(), "legacyGuestWorkspace", true));
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
        rows.isEmpty() ? DUMMY_PASSWORD : rows.getFirst().get("password_hash").toString();
    boolean valid = AccountPasswords.matches(str(b, "password"), encoded);
    if (rows.isEmpty() || !valid)
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid username/email or password");
    signIn(
        req,
        rows.getFirst().get("id").toString(),
        ((Number) rows.getFirst().get("auth_version")).intValue());
    return session(req);
  }

  private static final String DUMMY_PASSWORD = AccountPasswords.encode(AccountPasswords.token());

  void issue(String account, String kind) {
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
}
