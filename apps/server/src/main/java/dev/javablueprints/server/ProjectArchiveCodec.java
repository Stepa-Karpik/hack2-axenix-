package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/** Versioned, bounded data format. Historical graph/report data never grants authority. */
final class ProjectArchiveCodec {
  static final String FORMAT = "java-blueprints-project-archive-v1";
  static final int MAX_BYTES = 32 * 1024 * 1024;
  static final int MAX_REVISIONS = 64, MAX_RESOURCES = 256, MAX_LAYOUTS = 512;
  static final int MAX_WORKSPACE_BYTES = 32768;
  static final Set<String> KINDS =
      Set.of("analysis", "suite", "comparison", "single_run", "archive_import");
  static final ObjectMapper JSON = JsonMapper.builder().build();

  static ApiError invalid(String message) {
    return new ApiError(400, "ARCHIVE_INVALID", message);
  }

  static ApiError limit() {
    return new ApiError(
        413,
        "ARCHIVE_LIMIT_EXCEEDED",
        "Archive exceeds 32MiB, 64 revisions, 256 evidence records or 512 layouts");
  }

  static Map<String, Object> object(Object value) {
    if (!(value instanceof Map<?, ?> m)
        || m.keySet().stream().anyMatch(k -> !(k instanceof String)))
      throw invalid("Expected JSON object");
    return (Map<String, Object>) m;
  }

  static List<Map<String, Object>> objects(Object value, int max) {
    if (!(value instanceof List<?> list)) throw invalid("Expected JSON array");
    if (list.size() > max) throw limit();
    return list.stream().map(ProjectArchiveCodec::object).toList();
  }

  static void fields(Map<String, Object> value, String... names) {
    if (!value.keySet().equals(Set.of(names)))
      throw invalid("Unexpected or missing archive fields");
  }

  static String text(Map<String, Object> value, String name) {
    if (!(value.get(name) instanceof String s)) throw invalid("Expected text: " + name);
    TextTree.utf8(s);
    return s;
  }

  static String identifier(Object value) {
    if (!(value instanceof String s)) throw invalid("Expected archived identifier");
    try {
      UUID.fromString(s);
    } catch (IllegalArgumentException e) {
      throw invalid("Invalid archived identifier");
    }
    return s;
  }

  static String nullableIdentifier(Object value) {
    return value == null ? null : identifier(value);
  }

  static Object sorted(Object value, int depth) {
    if (depth > 128) throw invalid("Archive nesting limit");
    if (value instanceof Map<?, ?> m) {
      var result = new TreeMap<String, Object>();
      m.forEach(
          (k, v) -> {
            if (!(k instanceof String)) throw invalid("Invalid object key");
            result.put((String) k, sorted(v, depth + 1));
          });
      return result;
    }
    if (value instanceof List<?> list) return list.stream().map(v -> sorted(v, depth + 1)).toList();
    if (value instanceof String s) {
      TextTree.utf8(s);
      return s;
    }
    if (value instanceof Number number) {
      BigDecimal decimal;
      try {
        decimal = new BigDecimal(number.toString()).stripTrailingZeros();
      } catch (NumberFormatException e) {
        throw invalid("Nonfinite archive number");
      }
      if (decimal.abs().compareTo(new BigDecimal("9007199254740991")) > 0)
        throw invalid("Archive number exceeds lossless JSON transport range");
      return decimal;
    }
    if (value == null || value instanceof Boolean) return value;
    throw invalid("Unsupported JSON value");
  }

  static byte[] bytes(Object value) {
    return JSON.writeValueAsBytes(sorted(value, 0));
  }

  static String digest(Object value) {
    return hash(bytes(value));
  }

  static void metadata(Object value, int depth) {
    if (depth > 128) throw invalid("Archive nesting limit");
    if (value instanceof Map<?, ?> m)
      m.forEach(
          (key, item) -> {
            String name = key.toString().toLowerCase(Locale.ROOT).replace("_", "");
            if (Set.of(
                    "password",
                    "passwordhash",
                    "token",
                    "csrftoken",
                    "accesstoken",
                    "refreshtoken",
                    "authorization",
                    "cookie",
                    "sessionid",
                    "members",
                    "credentials",
                    "privatekey")
                .contains(name)) throw invalid("Account or credential metadata cannot be archived");
            metadata(item, depth + 1);
          });
    else if (value instanceof List<?> list) list.forEach(item -> metadata(item, depth + 1));
  }

  static Map<String, Object> seal(Map<String, Object> payload) {
    var manifest =
        map(
            "payloadSha256",
            digest(payload),
            "revisionHashes",
            hashes(objects(payload.get("revisions"), MAX_REVISIONS)),
            "resourceHashes",
            hashes(objects(payload.get("resources"), MAX_RESOURCES)),
            "layoutHashes",
            objects(payload.get("layouts"), MAX_LAYOUTS).stream()
                .map(ProjectArchiveCodec::digest)
                .toList());
    var result = map("format", FORMAT, "payload", payload, "manifest", manifest);
    validate(result);
    return result;
  }

  static Map<String, Object> hashes(List<Map<String, Object>> values) {
    var result = new TreeMap<String, Object>();
    for (var value : values)
      if (result.put(identifier(value.get("id")), digest(value)) != null)
        throw invalid("Duplicate archived identifier");
    return result;
  }

  static void safePath(String path) {
    TextTree.path(path);
    for (String part : path.toLowerCase(Locale.ROOT).split("/"))
      if (part.equals(".env")
          || part.startsWith(".env.")
          || Set.of("secrets", "credentials", ".git").contains(part)
          || part.endsWith(".pem")
          || part.endsWith(".key")
          || part.endsWith(".p12")
          || part.endsWith(".pfx")
          || part.endsWith(".jks")) throw invalid("Credential-like paths cannot be archived");
  }

  static List<String> directories(Map<String, Object> revision) {
    Object value = revision.get("directories");
    if (!(value instanceof List<?> list) || list.stream().anyMatch(v -> !(v instanceof String)))
      throw invalid("Invalid directory tree");
    var result = (List<String>) list;
    result.forEach(ProjectArchiveCodec::safePath);
    return result;
  }

  static Map<String, String> sources(Map<String, Object> revision) {
    var result = new TreeMap<String, String>();
    for (var file : objects(revision.get("files"), TextTree.MAX_ENTRIES)) {
      fields(file, "path", "canonicalText", "sourceHash", "rawBase64", "rawHash", "normalization");
      String path = text(file, "path"), canonical = text(file, "canonicalText");
      safePath(path);
      if (canonical.startsWith("\uFEFF")
          || canonical.indexOf('\r') >= 0
          || !hash(canonical).equals(file.get("sourceHash")))
        throw invalid("Canonical source hash or normalization mismatch");
      if (result.put(path, canonical) != null) throw invalid("Duplicate source path");
      var normalization = object(file.get("normalization"));
      fields(normalization, "bomRemoved", "lineEndingsNormalized");
      if (!(normalization.get("bomRemoved") instanceof Boolean)
          || !(normalization.get("lineEndingsNormalized") instanceof Boolean))
        throw invalid("Invalid normalization metadata");
      if (file.get("rawBase64") == null) {
        if (file.get("rawHash") != null) throw invalid("Missing raw source bytes");
      } else {
        byte[] raw = raw(file);
        String original = TextTree.decode(raw);
        if (!original
            .replaceFirst("^\uFEFF", "")
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .equals(canonical)) throw invalid("Raw and canonical sources disagree");
        if (!Objects.equals(normalization.get("bomRemoved"), original.startsWith("\uFEFF"))
            || !Objects.equals(normalization.get("lineEndingsNormalized"), original.contains("\r")))
          throw invalid("Raw normalization metadata disagrees");
      }
    }
    return result;
  }

  static byte[] raw(Map<String, Object> file) {
    String encoded = text(file, "rawBase64");
    if (encoded.length() > 2 * TextTree.MAX_BYTES) throw limit();
    byte[] raw;
    try {
      raw = Base64.getDecoder().decode(encoded);
    } catch (IllegalArgumentException e) {
      throw invalid("Invalid raw bytes");
    }
    if (raw.length > TextTree.MAX_BYTES || !hash(raw).equals(file.get("rawHash")))
      throw invalid("Raw source hash mismatch");
    return raw;
  }

  static Map<String, Object> validate(Map<String, Object> archive) {
    if (bytes(archive).length > MAX_BYTES) throw limit();
    fields(archive, "format", "payload", "manifest");
    if (!FORMAT.equals(archive.get("format"))) throw invalid("Unsupported archive format");
    var payload = object(archive.get("payload"));
    fields(
        payload,
        "createdAt",
        "headRevisionId",
        "originalRevisionId",
        "revisions",
        "resources",
        "layouts",
        "workspace");
    if (payload.get("workspace") != null) {
      var workspace = object(payload.get("workspace"));
      if (bytes(workspace).length > MAX_WORKSPACE_BYTES)
        throw invalid("Workspace snapshot exceeds 32KiB");
      metadata(workspace, 0);
    }
    try {
      Instant.parse(text(payload, "createdAt"));
    } catch (Exception e) {
      throw invalid("Invalid archive time");
    }
    var revisions = objects(payload.get("revisions"), MAX_REVISIONS);
    var ids = new HashSet<String>();
    var parents = new HashMap<String, String>();
    for (var revision : revisions) {
      fields(
          revision,
          "id",
          "parentRevisionId",
          "createdAt",
          "origin",
          "intent",
          "languageProfileId",
          "bundleHash",
          "treeHash",
          "directories",
          "files");
      String id = identifier(revision.get("id"));
      if (!ids.add(id)) throw invalid("Duplicate revision");
      parents.put(id, nullableIdentifier(revision.get("parentRevisionId")));
      if (!"java21-v1".equals(revision.get("languageProfileId")))
        throw invalid("Unsupported language profile");
      text(revision, "createdAt");
      text(revision, "origin");
      text(revision, "intent");
      var tree = new TextTree(sources(revision), directories(revision));
      if (!tree.hash().equals(revision.get("treeHash")))
        throw invalid("Directory/source tree hash mismatch");
      String bundle =
          tree.javaFiles().isEmpty()
              ? null
              : dev.javablueprints.engine.ProgramEngine.bundleHash(
                  new dev.javablueprints.engine.EngineModel.SourceBundle(id, tree.javaFiles()));
      if (!Objects.equals(bundle, revision.get("bundleHash")))
        throw invalid("Java bundle hash mismatch");
    }
    String head = nullableIdentifier(payload.get("headRevisionId")),
        original = nullableIdentifier(payload.get("originalRevisionId"));
    if ((head != null && !ids.contains(head))
        || (original != null && !ids.contains(original))
        || (revisions.isEmpty() != (head == null))
        || (revisions.isEmpty() != (original == null)))
      throw invalid("Missing head/original revision");
    for (String id : ids) {
      var seen = new HashSet<String>();
      String current = id;
      while (current != null) {
        if (!ids.contains(current) || !seen.add(current))
          throw invalid("Missing parent or revision cycle");
        current = parents.get(current);
      }
    }
    var resources = objects(payload.get("resources"), MAX_RESOURCES);
    var resourceIds = new HashSet<String>();
    var analyses = new HashMap<String, Map<String, Object>>();
    for (var resource : resources) {
      fields(resource, "id", "kind", "data");
      String id = identifier(resource.get("id"));
      if (!resourceIds.add(id) || !KINDS.contains(resource.get("kind")))
        throw invalid("Unknown or duplicate evidence record");
      var data = object(resource.get("data"));
      metadata(data, 0);
      if (!id.equals(data.get("id"))) throw invalid("Evidence identifier mismatch");
      if ("analysis".equals(resource.get("kind"))) {
        if (!ids.contains(data.get("revisionId"))) throw invalid("Analysis revision missing");
        analyses.put(id, data);
      }
      if ("comparison".equals(resource.get("kind"))
          && (!ids.contains(data.get("baseRevisionId"))
              || !ids.contains(data.get("candidateRevisionId"))))
        throw invalid("Comparison revisions missing");
    }
    for (var layout : objects(payload.get("layouts"), MAX_LAYOUTS)) {
      fields(layout, "revisionId", "analysisId", "methodId", "version", "data");
      String revision = identifier(layout.get("revisionId")),
          analysis = identifier(layout.get("analysisId"));
      var a = analyses.get(analysis);
      if (!ids.contains(revision)
          || a == null
          || !revision.equals(a.get("revisionId"))
          || !(layout.get("version") instanceof Number))
        throw invalid("Layout analysis binding missing");
      text(layout, "methodId");
      object(layout.get("data"));
      metadata(layout.get("data"), 0);
    }
    var manifest = object(archive.get("manifest"));
    fields(manifest, "payloadSha256", "revisionHashes", "resourceHashes", "layoutHashes");
    if (!digest(payload).equals(manifest.get("payloadSha256"))
        || !hashes(revisions).equals(manifest.get("revisionHashes"))
        || !hashes(resources).equals(manifest.get("resourceHashes"))
        || !objects(payload.get("layouts"), MAX_LAYOUTS).stream()
            .map(ProjectArchiveCodec::digest)
            .toList()
            .equals(manifest.get("layoutHashes")))
      throw invalid("Archive manifest checksum mismatch");
    return payload;
  }
}
