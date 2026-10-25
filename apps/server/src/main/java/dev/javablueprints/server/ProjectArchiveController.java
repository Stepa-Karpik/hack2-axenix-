package dev.javablueprints.server;

import static dev.javablueprints.server.ProjectArchiveCodec.*;
import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.*;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1")
final class ProjectArchiveController {
  private final Workspace w;
  private final ProjectArchiveService service;

  ProjectArchiveController(Workspace w, ProjectArchiveService service) {
    this.w = w;
    this.service = service;
  }

  Map<String, Object> ok(Object data) {
    return map("data", data, "meta", map("requestId", id()));
  }

  @PostMapping("/projects/{project}/archives")
  Object export(
      @PathVariable String project,
      @RequestHeader("Idempotency-Key") String key,
      @RequestBody Map<String, Object> body) {
    if (!Set.of("workspace").containsAll(body.keySet())) throw invalid("Unexpected export fields");
    Object workspace = body.get("workspace");
    if (workspace != null && bytes(object(workspace)).length > MAX_WORKSPACE_BYTES)
      throw invalid("Workspace snapshot exceeds 32KiB");
    return ResponseEntity.status(201)
        .body(
            ok(
                w.idem(
                    project + ":archive-export",
                    key,
                    body,
                    201,
                    () -> service.export(project, workspace))));
  }

  @PostMapping("/projects/{project}/archive-imports")
  Object restore(
      @PathVariable String project,
      @RequestHeader("Idempotency-Key") String key,
      @RequestHeader(value = "If-Match", required = false) String match,
      HttpServletRequest request)
      throws IOException {
    if (match == null) throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match: empty required");
    if (!"empty".equals(match.replace("\"", "")))
      throw new ApiError(
          409, "ARCHIVE_TARGET_NOT_EMPTY", "Archive import requires a new empty project");
    var body = read(request);
    var archive = object(body.get("archive"));
    var payload = validate(archive);
    return ResponseEntity.status(201)
        .body(
            ok(
                w.idem(
                    project + ":archive-import",
                    key,
                    body,
                    201,
                    () -> service.restore(project, archive, payload))));
  }

  static Map<String, Object> read(HttpServletRequest request) throws IOException {
    byte[] input = request.getInputStream().readNBytes(MAX_BYTES + 1);
    if (input.length > MAX_BYTES) throw limit();
    Map<String, Object> body;
    try {
      body = object(JSON.readValue(TextTree.decode(input), Map.class));
    } catch (ApiError e) {
      throw e;
    } catch (Exception e) {
      throw invalid("Invalid archive JSON");
    }
    fields(body, "archive");
    return body;
  }

  @PostMapping("/archive-previews")
  Object preview(@RequestHeader("Idempotency-Key") String key, HttpServletRequest request)
      throws IOException {
    uuid(key); // validation is deterministic and does not create DB resources
    var archive = object(read(request).get("archive"));
    var payload = validate(archive);
    long reports =
        objects(payload.get("resources"), MAX_RESOURCES).stream()
            .filter(r -> Set.of("comparison", "single_run").contains(r.get("kind")))
            .count();
    return ok(
        map(
            "format",
            FORMAT,
            "revisionCount",
            objects(payload.get("revisions"), MAX_REVISIONS).size(),
            "reportCount",
            reports,
            "sha256",
            hash(bytes(archive))));
  }

  @GetMapping("/projects/{project}/archive-imports/{receipt}")
  Object receipt(@PathVariable String project, @PathVariable String receipt) {
    return ok(w.resource(project, receipt, "archive_import"));
  }

  @GetMapping("/projects/{project}/archives/{artifact}")
  Object download(@PathVariable String project, @PathVariable String artifact) {
    var rows =
        w.db.queryForList(
            "SELECT bytes,sha256 FROM artifacts WHERE project_id=? AND id=? AND"
                + " kind='project_archive'",
            uuid(project),
            uuid(artifact));
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    return ResponseEntity.ok()
        .contentType(MediaType.APPLICATION_JSON)
        .header("Content-Disposition", "attachment; filename=\"project.jbp.json\"")
        .header("ETag", "\"" + row.get("sha256") + "\"")
        .body((byte[]) row.get("bytes"));
  }
}
