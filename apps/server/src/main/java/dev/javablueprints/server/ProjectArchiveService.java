package dev.javablueprints.server;

import static dev.javablueprints.server.ProjectArchiveCodec.*;
import static dev.javablueprints.server.Workspace.*;

import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;

/** Copies project data only. Imported evidence is never registered as runnable authority. */
@Service
final class ProjectArchiveService {
  private final Workspace w;

  ProjectArchiveService(Workspace w) {
    this.w = w;
  }

  Map<String, Object> export(String project, Object workspace) {
    // One MVCC statement captures head/history/resources/layouts consistently.
    var rows =
        w.db.queryForList(
            """
            SELECT p.head_revision_id::text AS head, p.original_revision_id::text AS original,
            (SELECT COALESCE(jsonb_agg(r.data),'[]')::text FROM
              (SELECT data FROM revisions WHERE project_id=p.id ORDER BY created_at,id LIMIT 65) r) AS revisions,
            (SELECT COALESCE(jsonb_agg(r.value),'[]')::text FROM
              (SELECT jsonb_build_object('id',id::text,'kind',kind,'data',data) AS value FROM resources
               WHERE project_id=p.id AND kind IN ('analysis','suite','comparison','single_run','archive_import')
               ORDER BY created_at,id LIMIT 257) r) AS resources,
            (SELECT COALESCE(jsonb_agg(r.value),'[]')::text FROM
              (SELECT jsonb_build_object('revisionId',revision_id::text,'analysisId',analysis_id::text,
                 'methodId',method_id,'version',version,'data',data) AS value FROM layouts
               WHERE project_id=p.id ORDER BY revision_id,analysis_id,method_id LIMIT 513) r) AS layouts
            FROM projects p WHERE p.id=?
            """,
            uuid(project));
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    var revisions =
        objects(w.json.readValue(row.get("revisions").toString(), List.class), MAX_REVISIONS);
    var resources =
        objects(w.json.readValue(row.get("resources").toString(), List.class), MAX_RESOURCES);
    var layouts = objects(w.json.readValue(row.get("layouts").toString(), List.class), MAX_LAYOUTS);
    var snapshots = new ArrayList<Map<String, Object>>();
    for (var revision : revisions) {
      var files = new ArrayList<Map<String, Object>>();
      for (var file : objects(revision.get("files"), TextTree.MAX_ENTRIES)) {
        String rawBase64 = null, rawHash = null;
        if (file.get("rawArtifactRef") != null) {
          var artifacts =
              w.db.queryForList(
                  "SELECT bytes,sha256 FROM artifacts WHERE project_id=? AND id=? AND"
                      + " kind='original_source'",
                  uuid(project),
                  uuid(file.get("rawArtifactRef").toString()));
          if (artifacts.isEmpty()) throw invalid("Original source artifact missing");
          byte[] raw = (byte[]) artifacts.getFirst().get("bytes");
          rawHash = artifacts.getFirst().get("sha256").toString();
          if (!hash(raw).equals(rawHash))
            throw invalid("Original source artifact checksum mismatch");
          rawBase64 = Base64.getEncoder().encodeToString(raw);
        }
        files.add(
            map(
                "path",
                file.get("path"),
                "canonicalText",
                file.get("canonicalText"),
                "sourceHash",
                file.get("sourceHash"),
                "rawBase64",
                rawBase64,
                "rawHash",
                rawHash,
                "normalization",
                file.getOrDefault(
                    "normalization", map("bomRemoved", false, "lineEndingsNormalized", false))));
      }
      snapshots.add(
          map(
              "id",
              revision.get("id"),
              "parentRevisionId",
              revision.get("parentRevisionId"),
              "createdAt",
              revision.get("createdAt"),
              "origin",
              revision.get("origin"),
              "intent",
              revision.get("intent"),
              "languageProfileId",
              revision.get("languageProfileId"),
              "bundleHash",
              revision.get("bundleHash"),
              "treeHash",
              revision.getOrDefault(
                  "treeHash", new TextTree(w.files(revision), w.directories(revision)).hash()),
              "directories",
              w.directories(revision),
              "files",
              files));
    }
    var allowed = new ArrayList<Map<String, Object>>();
    for (var resource : resources) {
      // Project identity, transport references and raw job payloads are not exported.
      var data = new LinkedHashMap<>(object(resource.get("data")));
      for (String field : List.of("projectId", "jobId", "attemptId", "testResultsRef", "ownerId"))
        data.remove(field);
      allowed.add(map("id", resource.get("id"), "kind", resource.get("kind"), "data", data));
    }
    var archive =
        seal(
            map(
                "createdAt",
                Instant.now().toString(),
                "headRevisionId",
                row.get("head"),
                "originalRevisionId",
                row.get("original"),
                "revisions",
                snapshots,
                "resources",
                allowed,
                "layouts",
                layouts,
                "workspace",
                workspace));
    byte[] bytes = bytes(archive);
    if (bytes.length > MAX_BYTES - 1024) throw limit(); // room for the import JSON wrapper
    String artifact = w.artifact(project, "project_archive", "application/json", bytes);
    long reports =
        allowed.stream()
            .filter(r -> Set.of("comparison", "single_run").contains(r.get("kind")))
            .count();
    return map(
        "artifactId",
        artifact,
        "downloadUrl",
        "/api/v1/projects/" + project + "/archives/" + artifact,
        "fileName",
        "project.jbp.json",
        "format",
        FORMAT,
        "revisionCount",
        snapshots.size(),
        "reportCount",
        reports,
        "sha256",
        hash(bytes));
  }

  Map<String, Object> restore(
      String project, Map<String, Object> archive, Map<String, Object> payload) {
    w.db.queryForObject("SELECT id FROM projects WHERE id=? FOR UPDATE", UUID.class, uuid(project));
    var projectState = w.project(project);
    if (!Set.of("owner", "local_guest").contains(projectState.get("role")))
      throw new ApiError(403, "ACCESS_DENIED", "Only a project owner may import an archive");
    // No existing source or detached history can be replaced or adopted.
    Integer existing =
        w.db.queryForObject(
            "SELECT count(*) FROM revisions WHERE project_id=?", Integer.class, uuid(project));
    Integer receipts =
        w.db.queryForObject(
            "SELECT count(*) FROM resources WHERE project_id=? AND kind='archive_import'",
            Integer.class,
            uuid(project));
    if (projectState.get("headRevisionId") != null || existing != 0 || receipts != 0)
      throw new ApiError(
          409, "ARCHIVE_TARGET_NOT_EMPTY", "Archive import requires a new empty project");
    var revisions = objects(payload.get("revisions"), MAX_REVISIONS);
    var mapping = new LinkedHashMap<String, String>();
    revisions.forEach(r -> mapping.put(identifier(r.get("id")), id()));
    var pending = new ArrayList<>(revisions);
    var inserted = new HashSet<String>();
    while (!pending.isEmpty()) {
      boolean progress = false;
      for (var iterator = pending.iterator(); iterator.hasNext(); ) {
        var old = iterator.next();
        String oldId = identifier(old.get("id"));
        String parent = nullableIdentifier(old.get("parentRevisionId"));
        if (parent != null && !inserted.contains(parent)) continue;
        var files = new ArrayList<Map<String, Object>>();
        for (var file : objects(old.get("files"), TextTree.MAX_ENTRIES)) {
          String rawRef =
              file.get("rawBase64") == null
                  ? null
                  : w.artifact(project, "original_source", "text/plain; charset=utf-8", raw(file));
          files.add(
              map(
                  "path",
                  file.get("path"),
                  "canonicalText",
                  file.get("canonicalText"),
                  "content",
                  file.get("canonicalText"),
                  "sourceHash",
                  file.get("sourceHash"),
                  "rawArtifactRef",
                  rawRef,
                  "rawHash",
                  file.get("rawHash"),
                  "normalization",
                  file.get("normalization")));
        }
        String next = mapping.get(oldId), newParent = parent == null ? null : mapping.get(parent);
        var revision =
            map(
                "id",
                next,
                "projectId",
                project,
                "parentRevisionId",
                newParent,
                "origin",
                "archive_import",
                "intent",
                "semantic_edit",
                "createdAt",
                Instant.now().toString(),
                "archivedRevisionId",
                oldId,
                "archivedCreatedAt",
                old.get("createdAt"),
                "verificationStatus",
                "unverified",
                "bundleHash",
                old.get("bundleHash"),
                "treeHash",
                old.get("treeHash"),
                "languageProfileId",
                "java21-v1",
                "directories",
                old.get("directories"),
                "files",
                files);
        w.db.update(
            "INSERT INTO revisions(id,project_id,parent_revision_id,data)VALUES(?,?,?,?::jsonb)",
            uuid(next),
            uuid(project),
            newParent == null ? null : uuid(newParent),
            w.encode(revision));
        inserted.add(oldId);
        iterator.remove();
        progress = true;
      }
      if (!progress) throw invalid("Revision graph cannot be imported");
    }
    String head = mapping.get(payload.get("headRevisionId"));
    if (head != null) {
      w.cas(project, "empty", head);
      String original = mapping.get(payload.get("originalRevisionId"));
      w.db.update(
          "UPDATE projects SET original_revision_id=? WHERE id=?",
          original == null ? null : uuid(original),
          uuid(project));
    }
    String receiptId = id();
    String archiveHash = hash(bytes(archive));
    long reportCount =
        objects(payload.get("resources"), MAX_RESOURCES).stream()
            .filter(r -> Set.of("comparison", "single_run").contains(r.get("kind")))
            .count();
    var receipt =
        map(
            "id",
            receiptId,
            "receiptId",
            receiptId,
            "headRevisionId",
            head,
            "revisionIdMap",
            mapping,
            "verificationStatus",
            "unverified",
            "historicalEvidence",
            "inert",
            "revisionCount",
            revisions.size(),
            "reportCount",
            reportCount,
            "archiveSha256",
            archiveHash,
            "createdAt",
            Instant.now().toString(),
            "archive",
            archive);
    // Only this new resource exists. Old report, suite, analysis and layout IDs
    // are deliberately not inserted into active resource/layout tables.
    w.putResource(project, receiptId, "archive_import", receipt);
    var response = new LinkedHashMap<>(receipt);
    response.remove("archive");
    if (head != null
        && !w.files(w.revision(project, head)).keySet().stream()
            .filter(p -> p.endsWith(".java"))
            .toList()
            .isEmpty())
      response.put("analysisJob", w.enqueue(project, "analyze", map("revisionId", head)));
    return response;
  }
}
