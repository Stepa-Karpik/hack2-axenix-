package dev.javablueprints.server;

import static dev.javablueprints.server.ProjectArchiveCodec.*;
import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.nio.charset.StandardCharsets;
import java.util.*;
import org.junit.jupiter.api.Test;

class ProjectArchiveCodecTest {
  static Map<String, Object> payload(String rawText) {
    String revision = id(),
        canonical = rawText.replaceFirst("^\uFEFF", "").replace("\r\n", "\n").replace('\r', '\n');
    byte[] raw = rawText.getBytes(StandardCharsets.UTF_8);
    var tree = new TextTree(Map.of("Main.java", canonical), List.of("empty"));
    var file =
        map(
            "path",
            "Main.java",
            "canonicalText",
            canonical,
            "sourceHash",
            hash(canonical),
            "rawBase64",
            Base64.getEncoder().encodeToString(raw),
            "rawHash",
            hash(raw),
            "normalization",
            map(
                "bomRemoved",
                rawText.startsWith("\uFEFF"),
                "lineEndingsNormalized",
                rawText.contains("\r")));
    var snapshot =
        map(
            "id",
            revision,
            "parentRevisionId",
            null,
            "createdAt",
            "2026-10-25T00:00:00Z",
            "origin",
            "import",
            "intent",
            "semantic_edit",
            "languageProfileId",
            "java21-v1",
            "bundleHash",
            dev.javablueprints.engine.ProgramEngine.bundleHash(
                new dev.javablueprints.engine.EngineModel.SourceBundle(revision, tree.javaFiles())),
            "treeHash",
            tree.hash(),
            "directories",
            List.of("empty"),
            "files",
            List.of(file));
    return map(
        "createdAt",
        "2026-10-25T00:00:00Z",
        "headRevisionId",
        revision,
        "originalRevisionId",
        revision,
        "revisions",
        List.of(snapshot),
        "resources",
        List.of(),
        "layouts",
        List.of(),
        "workspace",
        null);
  }

  static Map<String, Object> copy(Map<String, Object> value) {
    return JSON.readValue(bytes(value), Map.class);
  }

  static Map<String, Object> firstRevision(Map<String, Object> payload) {
    return objects(payload.get("revisions"), 64).getFirst();
  }

  static Map<String, Object> firstFile(Map<String, Object> payload) {
    return objects(firstRevision(payload).get("files"), 100).getFirst();
  }

  @Test
  void rawBomCrLfCanonicalUnicodeAndEmptyDirectoriesRoundTrip() {
    String source = "\uFEFFclass Main { String s=\"Привет\"; }\r\n";
    var archive = seal(payload(source));
    var decoded = copy(archive);
    var p = validate(decoded);
    assertEquals("class Main { String s=\"Привет\"; }\n", firstFile(p).get("canonicalText"));
    assertArrayEquals(source.getBytes(StandardCharsets.UTF_8), raw(firstFile(p)));
    assertEquals(List.of("empty"), firstRevision(p).get("directories"));
    assertEquals(digest(archive), digest(decoded));
  }

  @Test
  void refusesTamperedManifestCanonicalBytesRawBytesAndNormalization() {
    var archive = copy(seal(payload("class Main{}\n")));
    object(archive.get("manifest")).put("payloadSha256", "0".repeat(64));
    assertThrows(ApiError.class, () -> validate(archive));
    for (String field : List.of("canonicalText", "sourceHash", "rawHash", "rawBase64")) {
      var p = copy(payload("class Main{}\n"));
      firstFile(p).put(field, "tampered");
      assertThrows(ApiError.class, () -> seal(p), field);
    }
    var p = copy(payload("\uFEFFclass Main{}\r\n"));
    object(firstFile(p).get("normalization")).put("bomRemoved", false);
    assertThrows(ApiError.class, () -> seal(p));
  }

  @Test
  void refusesUnknownFieldsCyclesForeignParentsAndUnsupportedProfiles() {
    var p = copy(payload("class Main{}\n"));
    firstRevision(p).put("parentRevisionId", firstRevision(p).get("id"));
    assertThrows(ApiError.class, () -> seal(p));
    var q = copy(payload("class Main{}\n"));
    firstRevision(q).put("parentRevisionId", id());
    assertThrows(ApiError.class, () -> seal(q));
    var a = copy(seal(payload("class Main{}\n")));
    a.put("ownerId", id());
    assertThrows(ApiError.class, () -> validate(a));
    var r = copy(payload("class Main{}\n"));
    firstRevision(r).put("languageProfileId", "anything");
    assertThrows(ApiError.class, () -> seal(r));
  }

  @Test
  void refusesPathTraversalCredentialPathsAndCredentialMetadataEvenWithNewHashes() {
    for (String path :
        List.of(
            "../Main.java",
            "/Main.java",
            "C:/Main.java",
            ".env",
            "secrets/key.txt",
            "credential.key")) {
      var p = copy(payload("class Main{}\n"));
      firstFile(p).put("path", path);
      assertThrows(ApiError.class, () -> seal(p), path);
    }
    var p = copy(payload("class Main{}\n"));
    String resource = id();
    p.put(
        "resources",
        List.of(
            map(
                "id",
                resource,
                "kind",
                "suite",
                "data",
                map("id", resource, "token", "forbidden"))));
    assertThrows(ApiError.class, () -> seal(p));
  }

  @Test
  void refusesOversizedCountsAndUnboundLayoutsWithoutSilentlyTruncating() {
    var p = copy(payload("class Main{}\n"));
    p.put("revisions", Collections.nCopies(65, firstRevision(p)));
    assertEquals(413, assertThrows(ApiError.class, () -> seal(p)).status);
    var q = copy(payload("class Main{}\n"));
    q.put(
        "layouts",
        List.of(
            map(
                "revisionId",
                q.get("headRevisionId"),
                "analysisId",
                id(),
                "methodId",
                "method",
                "version",
                1,
                "data",
                map())));
    assertThrows(ApiError.class, () -> seal(q));
  }

  @Test
  void numberHashesSurviveBrowserIntegerFloatNormalization() {
    assertEquals(digest(map("x", 1, "y", 1000)), digest(map("x", 1.0, "y", 1e3)));
    assertThrows(ApiError.class, () -> digest(map("unsafe", 9007199254740992L)));
    assertThrows(ApiError.class, () -> digest(map("unsafe", Double.NaN)));
  }
}
