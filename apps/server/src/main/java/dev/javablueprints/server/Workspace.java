package dev.javablueprints.server;

import dev.javablueprints.engine.EngineModel.*;
import java.io.*;
import java.nio.charset.*;
import java.security.*;
import java.time.Instant;
import java.util.*;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@Service
public class Workspace {
  final ThreadLocal<List<Runnable>> publication = new ThreadLocal<>();

  void write(Runnable action) {
    var pending = publication.get();
    if (pending == null) action.run();
    else pending.add(action);
  }

  final JdbcTemplate db;
  final TransactionTemplate tx;
  final ObjectMapper json = JsonMapper.builder().build();

  Workspace(JdbcTemplate db, PlatformTransactionManager manager) {
    this.db = db;
    tx = new TransactionTemplate(manager);
  }

  static UUID uuid(String s) {
    try {
      return UUID.fromString(s);
    } catch (Exception e) {
      throw new ApiError(400, "INVALID_REQUEST", "Expected UUID");
    }
  }

  static String id() {
    return UUID.randomUUID().toString();
  }

  static Map<String, Object> map(Object... pairs) {
    var m = new LinkedHashMap<String, Object>();
    for (int i = 0; i < pairs.length; i += 2) m.put(pairs[i].toString(), pairs[i + 1]);
    return m;
  }

  String encode(Object o) {
    return json.writeValueAsString(o);
  }

  Map<String, Object> decode(String s) {
    return json.readValue(s, Map.class);
  }

  <T> T convert(Object o, Class<T> type) {
    return json.convertValue(o, type);
  }

  static String str(Map<String, Object> m, String key) {
    Object v = m.get(key);
    if (!(v instanceof String s) || s.isBlank())
      throw new ApiError(400, "INVALID_REQUEST", "Missing " + key);
    return s;
  }

  static String hash(byte[] bytes) {
    try {
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  static String hash(String s) {
    return hash(s.getBytes(StandardCharsets.UTF_8));
  }

  Map<String, Object> project(String p) {
    var rows =
        db.queryForList(
            "SELECT"
                + " id::text,name,head_revision_id::text,original_revision_id::text,created_at,updated_at"
                + " FROM projects WHERE id=?",
            uuid(p));
    if (rows.isEmpty()) throw missing();
    var r = rows.getFirst();
    return map(
        "id",
        r.get("id"),
        "name",
        r.get("name"),
        "headRevisionId",
        r.get("head_revision_id"),
        "originalRevisionId",
        r.get("original_revision_id"),
        "createdAt",
        r.get("created_at").toString(),
        "updatedAt",
        r.get("updated_at").toString(),
        "localOwnerId",
        "local");
  }

  static ApiError missing() {
    return new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found");
  }

  Map<String, Object> revision(String p, String r) {
    var rows =
        db.queryForList(
            "SELECT data::text FROM revisions WHERE project_id=? AND id=?", uuid(p), uuid(r));
    if (rows.isEmpty()) throw missing();
    return decode(rows.getFirst().get("data").toString());
  }

  List<Map<String, Object>> projects(int limit) {
    return db
        .queryForList(
            "SELECT id::text FROM projects ORDER BY created_at DESC,id DESC LIMIT ?", limit)
        .stream()
        .map(r -> project(r.get("id").toString()))
        .toList();
  }

  List<Map<String, Object>> revisions(String p, int limit) {
    project(p);
    return db
        .queryForList(
            "SELECT data::text FROM revisions WHERE project_id=? ORDER BY created_at DESC,id DESC"
                + " LIMIT ?",
            uuid(p),
            limit)
        .stream()
        .map(r -> decode(r.get("data").toString()))
        .toList();
  }

  Map<String, Object> createProject(String name) {
    if (name == null || name.isBlank() || name.length() > 120)
      throw new ApiError(400, "INVALID_REQUEST", "Name must contain 1..120 characters");
    String id = id();
    db.update("INSERT INTO projects(id,name)VALUES(?,?)", uuid(id), name);
    return project(id);
  }

  Map<String, Object> idem(
      String scope, String key, Object payload, int status, Supplier<Map<String, Object>> action) {
    if (key == null) throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key UUID required");
    UUID k = uuid(key);
    String digest = hash(encode(payload));
    return tx.execute(
        s -> {
          db.queryForObject(
              "SELECT pg_advisory_xact_lock(?)", Object.class, (long) (scope + key).hashCode());
          var old =
              db.queryForList(
                  "SELECT payload_hash,response::text FROM idempotency WHERE scope=? AND key=?",
                  scope,
                  k);
          if (!old.isEmpty()) {
            if (!digest.equals(old.getFirst().get("payload_hash")))
              throw new ApiError(
                  409, "IDEMPOTENCY_CONFLICT", "Key already used for another payload");
            return decode(old.getFirst().get("response").toString());
          }
          var result = action.get();
          db.update(
              "INSERT INTO"
                  + " idempotency(scope,key,payload_hash,response,status)VALUES(?,?,?,?::jsonb,?)",
              scope,
              k,
              digest,
              encode(result),
              status);
          return result;
        });
  }

  String expected(String header, Map<String, Object> body) {
    if (header == null) throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match required");
    String h = header.replace("\"", "");
    if (!h.equals("empty")) uuid(h);
    Object b = body.get("expectedHeadRevisionId");
    if (b != null && !b.toString().equals(h))
      throw new ApiError(400, "INVALID_REQUEST", "Body and If-Match disagree");
    return h;
  }

  void cas(String p, String expected, String next) {
    int n =
        db.update(
            "UPDATE projects SET head_revision_id=?,"
                + " original_revision_id=COALESCE(original_revision_id,?), updated_at=now() WHERE"
                + " id=? AND COALESCE(head_revision_id::text,'empty')=?",
            uuid(next),
            uuid(next),
            uuid(p),
            expected);
    if (n != 1) throw new ApiError(409, "REVISION_CONFLICT", "Project head changed");
    db.update(
        "INSERT INTO audit_events(project_id,event,entity_id) VALUES(?,'head_changed',?)",
        uuid(p),
        uuid(next));
  }

  Map<String, String> files(Map<String, Object> rev) {
    Map<String, String> m = new TreeMap<>();
    for (Object f : (List<?>) rev.get("files")) {
      var file = (Map<?, ?>) f;
      m.put(file.get("path").toString(), file.get("canonicalText").toString());
    }
    return m;
  }

  Map<String, Object> save(
      String p,
      String expected,
      Map<String, String> texts,
      Map<String, byte[]> raw,
      String origin,
      String intent,
      boolean head) {
    var project = project(p);
    if (head && !expected.equals(Objects.toString(project.get("headRevisionId"), "empty")))
      throw new ApiError(409, "REVISION_CONFLICT", "Project head changed");
    if (texts.isEmpty() || texts.size() > 100)
      throw new ApiError(413, "INPUT_LIMIT_EXCEEDED", "Expected 1..100 Java files");
    var canonical = new TreeMap<String, String>();
    long size = 0;
    for (var e : texts.entrySet()) {
      String path = e.getKey();
      dev.javablueprints.verification.RunnerProtocol.path(path);
      if (!path.matches("[A-Za-z0-9_$.-]+(?:/[A-Za-z0-9_$.-]+)*\\.java")
          || Arrays.asList(path.split("/")).contains("..")
          || Arrays.asList(path.split("/")).contains("."))
        throw new ApiError(400, "INVALID_REQUEST", "Unsafe Java source path");
      String text = e.getValue();
      if (text == null) throw new ApiError(400, "INVALID_REQUEST", "Content required");
      try {
        size +=
            StandardCharsets.UTF_8
                .newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .encode(java.nio.CharBuffer.wrap(text))
                .remaining();
      } catch (CharacterCodingException ex) {
        throw new ApiError(400, "INVALID_REQUEST", "Source must contain valid Unicode");
      }
      canonical.put(
          path, text.replaceFirst("^\uFEFF", "").replace("\r\n", "\n").replace('\r', '\n'));
    }
    if (size > 1048576) throw new ApiError(413, "INPUT_LIMIT_EXCEEDED", "Project limit is 1 MiB");
    String r = id();
    var fs = new ArrayList<Map<String, Object>>();
    var bundle = new ByteArrayOutputStream();
    try (var data = new DataOutputStream(bundle)) {
      data.writeUTF("java21-v1");
      for (var e : canonical.entrySet()) {
        byte[] path = e.getKey().getBytes(StandardCharsets.UTF_8);
        byte[] contentHash = HexFormat.of().parseHex(hash(e.getValue()));
        data.writeInt(path.length);
        data.write(path);
        data.writeInt(contentHash.length);
        data.write(contentHash);
        byte[] original = raw.get(e.getKey());
        String rawRef =
            original == null
                ? null
                : artifact(p, "original_source", "text/plain; charset=utf-8", original);
        fs.add(
            map(
                "path",
                e.getKey(),
                "canonicalText",
                e.getValue(),
                "content",
                e.getValue(),
                "sourceHash",
                hash(e.getValue()),
                "rawArtifactRef",
                rawRef,
                "rawHash",
                original == null ? null : hash(original),
                "normalization",
                map(
                    "bomRemoved",
                    texts.get(e.getKey()).startsWith("\uFEFF"),
                    "lineEndingsNormalized",
                    texts.get(e.getKey()).contains("\r"))));
      }
    } catch (IOException e) {
      throw new IllegalStateException(e);
    }
    var rev =
        map(
            "id",
            r,
            "projectId",
            p,
            "parentRevisionId",
            expected.equals("empty") ? null : expected,
            "origin",
            origin,
            "intent",
            intent,
            "createdAt",
            Instant.now().toString(),
            "bundleHash",
            dev.javablueprints.engine.ProgramEngine.bundleHash(new SourceBundle(r, canonical)),
            "languageProfileId",
            "java21-v1",
            "files",
            fs);
    write(
        () ->
            db.update(
                "INSERT INTO"
                    + " revisions(id,project_id,parent_revision_id,data)VALUES(?,?,?,?::jsonb)",
                uuid(r),
                uuid(p),
                expected.equals("empty") ? null : uuid(expected),
                encode(rev)));
    if (head) cas(p, expected, r);
    return rev;
  }

  String artifact(String p, String kind, String media, byte[] bytes) {
    String a = id();
    write(
        () ->
            db.update(
                "INSERT INTO"
                    + " artifacts(project_id,id,kind,media_type,sha256,bytes)VALUES(?,?,?,?,?,?)",
                uuid(p),
                uuid(a),
                kind,
                media,
                hash(bytes),
                bytes));
    return a;
  }

  String resource(String p, String kind, Object value) {
    String id = id();
    putResource(p, id, kind, value);
    return id;
  }

  void putResource(String p, String id, String kind, Object value) {
    String encoded = encode(value);
    write(
        () ->
            db.update(
                "INSERT INTO resources(project_id,id,kind,data)VALUES(?,?,?,?::jsonb)",
                uuid(p),
                uuid(id),
                kind,
                encoded));
  }

  Map<String, Object> resource(String p, String id, String kind) {
    var rows =
        db.queryForList(
            "SELECT data::text FROM resources WHERE project_id=? AND id=? AND kind=?",
            uuid(p),
            uuid(id),
            kind);
    if (rows.isEmpty()) throw missing();
    return decode(rows.getFirst().get("data").toString());
  }

  void updateResource(String p, String id, String kind, Object value) {
    String encoded = encode(value);
    write(
        () -> {
          if (db.update(
                  "UPDATE resources SET data=?::jsonb WHERE project_id=? AND id=? AND kind=?",
                  encoded,
                  uuid(p),
                  uuid(id),
                  kind)
              != 1) throw missing();
        });
  }

  Map<String, Object> analysis(String p, String r, String a) {
    revision(p, r);
    Map<String, Object> result;
    if (a != null) result = resource(p, a, "analysis");
    else {
      var rows =
          db.queryForList(
              "SELECT data::text FROM resources WHERE project_id=? AND kind='analysis' AND"
                  + " data->>'revisionId'=? AND data->>'analyzerVersion'=? AND"
                  + " data->>'sourceMapVersion'=? ORDER BY created_at DESC,id DESC LIMIT 1",
              uuid(p),
              r,
              dev.javablueprints.engine.ProgramEngine.VERSION,
              dev.javablueprints.engine.ProgramEngine.SOURCE_MAP_VERSION);
      if (rows.isEmpty()) throw new ApiError(404, "ANALYSIS_NOT_READY", "No analysis for revision");
      result = decode(rows.getFirst().get("data").toString());
    }
    if (!r.equals(result.get("revisionId")))
      throw new ApiError(409, "ANALYSIS_CONFLICT", "Analysis belongs to another revision");
    return result;
  }

  Map<String, Object> enqueue(String p, String type, Map<String, Object> input) {
    project(p);
    String j = id();
    db.update(
        "INSERT INTO jobs(id,project_id,type,input)VALUES(?,?,?,?::jsonb)",
        uuid(j),
        uuid(p),
        type,
        encode(input));
    return job(p, j);
  }

  Map<String, Object> job(String p, String j) {
    var rows =
        db.queryForList(
            "SELECT"
                + " id::text,type,status,attempt_id::text,result::text,error::text,cancel_requested_at,created_at,finished_at"
                + " FROM jobs WHERE project_id=? AND id=?",
            uuid(p),
            uuid(j));
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    return map(
        "id",
        row.get("id"),
        "jobId",
        row.get("id"),
        "projectId",
        p,
        "type",
        row.get("type"),
        "status",
        row.get("status"),
        "attemptId",
        row.get("attempt_id"),
        "result",
        row.get("result") == null ? null : decode(row.get("result").toString()),
        "error",
        row.get("error") == null ? null : decode(row.get("error").toString()),
        "cancelRequestedAt",
        Objects.toString(row.get("cancel_requested_at"), null),
        "createdAt",
        row.get("created_at").toString(),
        "finishedAt",
        Objects.toString(row.get("finished_at"), null));
  }
}

class ApiError extends RuntimeException {
  final int status;
  final String code;

  ApiError(int status, String code, String message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
