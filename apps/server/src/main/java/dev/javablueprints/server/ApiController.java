package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import dev.javablueprints.engine.EngineModel.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.nio.*;
import java.nio.charset.*;
import java.util.*;
import java.util.zip.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1")
public class ApiController {
  final Workspace w;
  final JobWorker worker;

  ApiController(Workspace w, JobWorker worker) {
    this.w = w;
    this.worker = worker;
  }

  Map<String, Object> ok(Object data) {
    return map("data", data, "meta", map("requestId", id()));
  }

  ResponseEntity<Map<String, Object>> mutation(
      String scope,
      String key,
      Object input,
      int status,
      java.util.function.Supplier<Map<String, Object>> f) {
    return ResponseEntity.status(status).body(ok(w.idem(scope, key, input, status, f)));
  }

  @GetMapping("/health")
  Object health() {
    return ok(map("status", "up", "version", "0.1.0-SNAPSHOT"));
  }

  @GetMapping("/capabilities")
  Object capabilities() {
    return ok(
        map(
            "localMode",
            true,
            "javaRelease",
            21,
            "languageProfileId",
            "java21-v1",
            "implementedCommands",
            List.of("replace_expression", "insert_statement", "delete_statement"),
            "runner",
            map("available", worker.available(), "profileId", "java21-v1"),
            "limits",
            map("maxProjectBytes", 1048576, "maxProjectFiles", 100, "maxTestCases", 100),
            "unsupported",
            List.of("method_harness", "benchmark", "llm", "class_decomposition")));
  }

  @GetMapping("/session")
  Object session(HttpServletRequest req) {
    var s = req.getSession(true);
    if (s.getAttribute("csrf") == null) s.setAttribute("csrf", id());
    return ok(map("mode", "local", "csrfToken", s.getAttribute("csrf"), "localOwnerId", "local"));
  }

  @GetMapping("/projects")
  Object projects(@RequestParam(defaultValue = "20") int limit) {
    return ok(w.projects(limit(limit)));
  }

  @PostMapping("/projects")
  Object project(
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "name");
    return mutation("projects", key, b, 201, () -> w.createProject(str(b, "name")));
  }

  @GetMapping("/projects/{p}")
  Object project(@PathVariable String p) {
    return ok(w.project(p));
  }

  @GetMapping("/projects/{p}/revisions")
  Object revisions(@PathVariable String p, @RequestParam(defaultValue = "20") int limit) {
    return ok(w.revisions(p, limit(limit)));
  }

  @GetMapping("/projects/{p}/revisions/{r}")
  Object revision(@PathVariable String p, @PathVariable String r) {
    return ok(w.revision(p, r));
  }

  @PostMapping("/projects/{p}/revisions")
  Object save(
      @PathVariable String p,
      @RequestHeader(value = "If-Match", required = false) String match,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "expectedHeadRevisionId", "files", "intent");
    String expected = w.expected(match, b);
    if (!Objects.toString(b.getOrDefault("intent", "semantic_edit")).equals("semantic_edit"))
      throw new ApiError(400, "INVALID_REQUEST", "Text save intent must be semantic_edit");
    Map<String, String> texts = texts(b);
    return mutation(
        p + ":revision",
        key,
        map("expected", expected, "body", b),
        201,
        () -> w.save(p, expected, texts, Map.of(), "text_edit", "semantic_edit", true));
  }

  @PostMapping(value = "/projects/{p}/imports", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  Object imports(
      @PathVariable String p,
      @RequestHeader(value = "If-Match", required = false) String match,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestParam("files") List<MultipartFile> fs,
      @RequestParam(defaultValue = "java21-v1") String languageProfileId)
      throws IOException {
    if (!languageProfileId.equals("java21-v1"))
      throw new ApiError(400, "INVALID_REQUEST", "Unknown language profile");
    String expected = w.expected(match, Map.of());
    var texts = new TreeMap<String, String>();
    var raw = new TreeMap<String, byte[]>();
    for (var f : fs) {
      String path = f.getOriginalFilename();
      byte[] bytes = f.getBytes();
      if (bytes.length > 1048576)
        throw new ApiError(413, "INPUT_LIMIT_EXCEEDED", "File exceeds limit");
      String text;
      try {
        text =
            StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString();
      } catch (CharacterCodingException e) {
        throw new ApiError(400, "INVALID_REQUEST", "Source must be strict UTF-8");
      }
      if (texts.put(path, text) != null)
        throw new ApiError(400, "INVALID_REQUEST", "Duplicate source path");
      raw.put(path, bytes);
    }
    return mutation(
        p + ":import",
        key,
        map("expected", expected, "files", texts, "profile", languageProfileId),
        201,
        () -> {
          var rev = w.save(p, expected, texts, raw, "import", "semantic_edit", true);
          var job = w.enqueue(p, "analyze", map("revisionId", rev.get("id")));
          rev.put("analysisJob", job);
          return rev;
        });
  }

  @PostMapping("/projects/{p}/revisions/{r}/restore")
  Object restore(
      @PathVariable String p,
      @PathVariable String r,
      @RequestHeader(value = "If-Match", required = false) String match,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "expectedHeadRevisionId");
    str(b, "expectedHeadRevisionId");
    String expected = w.expected(match, b);
    return mutation(
        p + ":restore", key, map("sourceRevisionId", r, "expected", expected), 201,
        () -> {
          var restored = w.restore(p, r, expected);
          restored.put("analysisJob", w.enqueue(p, "analyze", map("revisionId", restored.get("id"))));
          return restored;
        });
  }

  @PostMapping("/projects/{p}/revisions/{r}/analysis")
  Object analyze(
      @PathVariable String p,
      @PathVariable String r,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody(required = false) Map<String, Object> b) {
    w.revision(p, r);
    if (b != null) fields(b, "rulesetVersion");
    return mutation(
        p + ":analyze:" + r,
        key,
        b == null ? Map.of() : b,
        202,
        () -> w.enqueue(p, "analyze", map("revisionId", r)));
  }

  @GetMapping("/projects/{p}/revisions/{r}/analysis")
  Object analysis(
      @PathVariable String p,
      @PathVariable String r,
      @RequestParam(required = false) String analysisId) {
    return ok(w.analysis(p, r, analysisId));
  }

  @GetMapping("/projects/{p}/revisions/{r}/graph")
  Object graph(
      @PathVariable String p,
      @PathVariable String r,
      @RequestParam String analysisId,
      @RequestParam(required = false) String methodId) {
    var a = w.analysis(p, r, analysisId);
    if (!a.get("parseStatus").equals("valid") || a.get("graph") == null)
      throw new ApiError(409, "GRAPH_UNAVAILABLE", "Revision has no valid graph");
    if (methodId == null) return ok(a.get("graph"));
    binding(a, methodId);
    var g = new LinkedHashMap<>((Map<String, Object>) a.get("graph"));
    var nodes =
        ((List<Map<String, Object>>) g.get("nodes"))
            .stream().filter(n -> methodId.equals(n.get("methodId"))).toList();
    var ids = new HashSet<String>();
    nodes.forEach(n -> ids.add(n.get("id").toString()));
    g.put("nodes", nodes);
    g.put(
        "methods",
        ((List<Map<String, Object>>) g.get("methods"))
            .stream().filter(m -> methodId.equals(m.get("id"))).toList());
    g.put(
        "edges",
        ((List<Map<String, Object>>) g.get("edges"))
            .stream()
                .filter(e -> ids.contains(e.get("source")) && ids.contains(e.get("target")))
                .toList());
    return ok(g);
  }

  @GetMapping("/projects/{p}/revisions/{r}/layout")
  Object layout(
      @PathVariable String p,
      @PathVariable String r,
      @RequestParam String analysisId,
      @RequestParam String methodId) {
    var a = w.analysis(p, r, analysisId);
    binding(a, methodId);
    var rows =
        w.db.queryForList(
            "SELECT data::text FROM layouts WHERE project_id=? AND revision_id=? AND analysis_id=?"
                + " AND method_id=?",
            uuid(p),
            uuid(r),
            uuid(analysisId),
            methodId);
    return ok(
        rows.isEmpty()
            ? map(
                "projectId",
                p,
                "revisionId",
                r,
                "analysisId",
                analysisId,
                "methodId",
                methodId,
                "sourceMapVersion",
                a.get("sourceMapVersion"),
                "layoutVersion",
                0,
                "positions",
                List.of(),
                "collapsedNodeIds",
                List.of(),
                "viewport",
                map("x", 0, "y", 0, "zoom", 1))
            : w.decode(rows.getFirst().get("data").toString()));
  }

  @PutMapping("/projects/{p}/revisions/{r}/layout")
  Object layout(
      @PathVariable String p, @PathVariable String r, @RequestBody Map<String, Object> b) {
    fields(
        b,
        "analysisId",
        "sourceMapVersion",
        "methodId",
        "layoutVersion",
        "positions",
        "collapsedNodeIds",
        "viewport");
    String a = str(b, "analysisId"), m = str(b, "methodId");
    var analysis = w.analysis(p, r, a);
    binding(analysis, m);
    if (!Objects.equals(analysis.get("sourceMapVersion"), b.get("sourceMapVersion")))
      throw new ApiError(409, "ANALYSIS_CONFLICT", "Source map changed");
    validateLayout(analysis, m, b);
    int version = ((Number) b.get("layoutVersion")).intValue();
    var result = new LinkedHashMap<>(b);
    result.put("layoutVersion", version + 1);
    result.put("projectId", p);
    result.put("revisionId", r);
    w.tx.executeWithoutResult(
        tx -> {
          int n;
          if (version == 0)
            n =
                w.db.update(
                    "INSERT INTO layouts(project_id,revision_id,analysis_id,method_id,version,data)"
                        + " VALUES(?,?,?,?,1,?::jsonb) ON CONFLICT DO NOTHING",
                    uuid(p),
                    uuid(r),
                    uuid(a),
                    m,
                    w.encode(result));
          else
            n =
                w.db.update(
                    "UPDATE layouts SET version=version+1,data=?::jsonb WHERE project_id=? AND"
                        + " revision_id=? AND analysis_id=? AND method_id=? AND version=?",
                    w.encode(result),
                    uuid(p),
                    uuid(r),
                    uuid(a),
                    m,
                    version);
          if (n != 1) throw new ApiError(409, "LAYOUT_CONFLICT", "Layout changed");
        });
    return ok(result);
  }

  @PostMapping("/projects/{p}/changes")
  Object change(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(
        b, "baseRevisionId", "analysisId", "methodId", "nodeId", "operation", "payload", "intent");
    editPayload(b);
    str(b, "methodId");
    str(b, "nodeId");
    String r = str(b, "baseRevisionId");
    w.analysis(p, r, str(b, "analysisId"));
    if (!Set.of("semantic_edit", "preserve_behavior").contains(str(b, "intent")))
      throw new ApiError(400, "INVALID_REQUEST", "Unknown intent");
    return mutation(
        p + ":change",
        key,
        b,
        202,
        () -> {
          String c = id();
          var proposal =
              map(
                  "id",
                  c,
                  "proposalId",
                  c,
                  "projectId",
                  p,
                  "baseRevisionId",
                  r,
                  "intent",
                  b.get("intent"),
                  "command",
                  b,
                  "status",
                  "queued",
                  "createdAt",
                  java.time.Instant.now().toString());
          w.putResource(p, c, "proposal", proposal);
          var input = new LinkedHashMap<>(b);
          input.put("proposalId", c);
          var job = w.enqueue(p, "change", input);
          proposal.put("jobId", job.get("id"));
          w.updateResource(p, c, "proposal", proposal);
          return proposal;
        });
  }

  @GetMapping("/projects/{p}/changes/{c}")
  Object change(@PathVariable String p, @PathVariable String c) {
    return ok(w.resource(p, c, "proposal"));
  }

  @PostMapping("/projects/{p}/head")
  Object apply(
      @PathVariable String p,
      @RequestHeader(value = "If-Match", required = false) String match,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(
        b, "expectedHeadRevisionId", "candidateRevisionId", "proposalId", "verificationReportId");
    String expected = w.expected(match, b);
    return mutation(
        p + ":head",
        key,
        map("expected", expected, "body", b),
        200,
        () -> {
          var proposal = w.resource(p, str(b, "proposalId"), "proposal");
          String candidate = str(b, "candidateRevisionId");
          if (!candidate.equals(proposal.get("candidateRevisionId"))
              || !expected.equals(proposal.get("baseRevisionId"))
              || !"ready".equals(proposal.get("status")))
            throw new ApiError(409, "INVALID_CHANGE", "Proposal is not ready for this head");
          var checks = (Map<?, ?>) proposal.get("checks");
          if (!"passed".equals(checks.get("compileStatus")))
            throw new ApiError(409, "INVALID_CHANGE", "Candidate has not compiled");
          if ("preserve_behavior".equals(proposal.get("intent"))) {
            var report = w.resource(p, str(b, "verificationReportId"), "comparison");
            if (!Boolean.TRUE.equals(report.get("coverageComplete"))
                || !"succeeded".equals(w.job(p, str(report, "jobId")).get("status"))
                || !JobWorker.PROFILE_HASH.equals(report.get("executionProfileHash"))
                || !"matched_on_tests".equals(report.get("outcome"))
                || !expected.equals(report.get("baseRevisionId"))
                || !candidate.equals(report.get("candidateRevisionId"))
                || !"java21-v1".equals(report.get("executionProfileId")))
              throw new ApiError(409, "INVALID_CHANGE", "Exact matched comparison is required");
          }
          var proposalJob = w.job(p, str(proposal, "jobId"));
          if (!"succeeded".equals(proposalJob.get("status")))
            throw new ApiError(409, "INVALID_CHANGE", "Proposal attempt is not successful");
          w.revision(p, candidate);
          w.cas(p, expected, candidate);
          proposal.put("status", "applied");
          w.updateResource(p, str(b, "proposalId"), "proposal", proposal);
          return w.project(p);
        });
  }

  @PostMapping("/projects/{p}/test-suites")
  Object suite(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "mode", "entryPoint", "cases", "seed", "comparisonPolicyId", "oracleSpec", "origin");
    w.project(p);
    if (!"console".equals(b.get("mode")) || !"exact-v1".equals(b.get("comparisonPolicyId")))
      throw new ApiError(422, "UNSUPPORTED_CONSTRUCT", "Only console exact-v1 suite supported");
    entry(str(b, "entryPoint"));
    var cases = (List<?>) b.get("cases");
    if (cases == null || cases.isEmpty() || cases.size() > 100)
      throw new ApiError(400, "INVALID_REQUEST", "Expected 1..100 cases");
    Set<String> ids = new HashSet<>();
    for (Object c : cases) {
      Map<String, Object> cs = (Map<String, Object>) c;
      fields(
          cs,
          "id",
          "name",
          "stdinUtf8",
          "argv",
          "expectedExitCodes",
          "expectedExitCode",
          "expectedStdout",
          "expectedStderr",
          "tags");
      dev.javablueprints.verification.RunnerProtocol.id(str(cs, "id"));
      if (!ids.add(str(cs, "id"))) throw new ApiError(400, "INVALID_REQUEST", "Duplicate case id");
      validateInput(cs);
    }
    return mutation(
        p + ":suite",
        key,
        b,
        201,
        () -> {
          var s = new LinkedHashMap<>(b);
          String id = id();
          s.put("id", id);
          s.put("projectId", p);
          s.put("versionHash", hash(w.encode(b)));
          s.put("createdAt", java.time.Instant.now().toString());
          w.putResource(p, id, "suite", s);
          return s;
        });
  }

  @GetMapping("/projects/{p}/test-suites/{s}")
  Object suite(@PathVariable String p, @PathVariable String s) {
    return ok(w.resource(p, s, "suite"));
  }

  @PostMapping("/projects/{p}/compilations")
  Object compile(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "revisionId", "profileId");
    w.revision(p, str(b, "revisionId"));
    profile(b);
    worker.requireAvailable();
    return mutation(p + ":compile", key, b, 202, () -> w.enqueue(p, "compile", b));
  }

  @PostMapping("/projects/{p}/runs")
  Object run(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "revisionId", "profileId", "entryPoint", "argv", "stdinUtf8");
    w.revision(p, str(b, "revisionId"));
    profile(b);
    entry(str(b, "entryPoint"));
    validateInput(b);
    worker.requireAvailable();
    return mutation(p + ":run", key, b, 202, () -> w.enqueue(p, "run", b));
  }

  @PostMapping("/projects/{p}/comparisons")
  Object compare(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "baseRevisionId", "candidateRevisionId", "suiteVersionId", "profileId");
    w.revision(p, str(b, "baseRevisionId"));
    w.revision(p, str(b, "candidateRevisionId"));
    w.resource(p, str(b, "suiteVersionId"), "suite");
    profile(b);
    worker.requireAvailable();
    return mutation(p + ":compare", key, b, 202, () -> w.enqueue(p, "compare", b));
  }

  @GetMapping({"/projects/{p}/jobs/{j}", "/projects/{p}/runs/{j}"})
  Object job(@PathVariable String p, @PathVariable String j) {
    return ok(w.job(p, j));
  }

  @GetMapping("/projects/{p}/comparisons/{c}")
  Object comparison(@PathVariable String p, @PathVariable String c) {
    return ok(w.resource(p, c, "comparison"));
  }

  @GetMapping("/projects/{p}/comparisons/{c}/test-results")
  Object tests(@PathVariable String p, @PathVariable String c) {
    return ok(w.resource(p, c, "comparison").get("testResults"));
  }

  @PostMapping("/projects/{p}/jobs/{j}/cancel")
  Object cancel(
      @PathVariable String p,
      @PathVariable String j,
      @RequestHeader(value = "Idempotency-Key", required = false) String key) {
    return mutation(
        p + ":cancel:" + j,
        key,
        Map.of(),
        202,
        () -> {
          w.job(p, j);
          w.db.update(
              "UPDATE jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),status=CASE"
                  + " WHEN status='queued' THEN 'cancelled' ELSE status END,finished_at=CASE WHEN"
                  + " status='queued' THEN now() ELSE finished_at END WHERE project_id=? AND id=?"
                  + " AND status IN ('queued','running')",
              uuid(p),
              uuid(j));
          return w.job(p, j);
        });
  }

  @GetMapping("/projects/{p}/artifacts/{a}")
  Object artifact(@PathVariable String p, @PathVariable String a) {
    var rows =
        w.db.queryForList(
            "SELECT media_type,sha256,bytes FROM artifacts WHERE project_id=? AND id=?",
            uuid(p),
            uuid(a));
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    return ResponseEntity.ok()
        .header("Content-Disposition", "attachment; filename=\"artifact-" + a + "\"")
        .header("ETag", "\"" + row.get("sha256") + "\"")
        .contentType(MediaType.parseMediaType(row.get("media_type").toString()))
        .body((byte[]) row.get("bytes"));
  }

  @PostMapping("/projects/{p}/exports")
  Object export(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "revisionId", "includeReportIds");
    var rev = w.revision(p, str(b, "revisionId"));
    return mutation(
        p + ":export",
        key,
        b,
        201,
        () -> {
          try {
            var bytes = new ByteArrayOutputStream();
            try (var zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
              for (var file : w.files(rev).entrySet()) {
                zip.putNextEntry(new ZipEntry(file.getKey()));
                zip.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
              }
              for (Object report : (List<?>) b.getOrDefault("includeReportIds", List.of())) {
                var result = w.resource(p, report.toString(), "comparison");
                zip.putNextEntry(new ZipEntry("reports/" + uuid(report.toString()) + ".json"));
                zip.write(w.encode(result).getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
              }
            }
            String a = w.artifact(p, "source_export", "application/zip", bytes.toByteArray());
            return map(
                "id",
                a,
                "artifactId",
                a,
                "revisionId",
                rev.get("id"),
                "downloadUrl",
                "/api/v1/projects/" + p + "/artifacts/" + a);
          } catch (IOException e) {
            throw new IllegalStateException(e);
          }
        });
  }

  static void validateLayout(Map<String, Object> analysis, String method, Map<String, Object> b) {
    var graph = (Map<String, Object>) analysis.get("graph");
    var ids = new HashSet<String>();
    for (var n : (List<Map<String, Object>>) graph.get("nodes"))
      if (method.equals(n.get("methodId"))) ids.add(n.get("id").toString());
    if (!(b.get("positions") instanceof List<?> positions)
        || positions.size() > 10000
        || !(b.get("collapsedNodeIds") instanceof List<?> collapsed)
        || collapsed.size() > 10000)
      throw new ApiError(400, "INVALID_REQUEST", "Invalid layout arrays");
    var seen = new HashSet<String>();
    for (Object obj : positions) {
      var n = (Map<String, Object>) obj;
      fields(n, "nodeId", "x", "y");
      String node = str(n, "nodeId");
      if (!ids.contains(node) || !seen.add(node))
        throw new ApiError(409, "ANALYSIS_CONFLICT", "Layout node binding mismatch");
      coordinate(n.get("x"), 1000000);
      coordinate(n.get("y"), 1000000);
    }
    for (Object node : collapsed)
      if (!(node instanceof String) || !ids.contains(node))
        throw new ApiError(409, "ANALYSIS_CONFLICT", "Collapsed node binding mismatch");
    var viewport = (Map<String, Object>) b.get("viewport");
    fields(viewport, "x", "y", "zoom");
    coordinate(viewport.get("x"), 1000000);
    coordinate(viewport.get("y"), 1000000);
    double zoom = coordinate(viewport.get("zoom"), 10);
    if (zoom < 0.05) throw new ApiError(400, "INVALID_REQUEST", "Zoom outside range");
    if (!(b.get("layoutVersion") instanceof Number n)
        || n.doubleValue() != n.intValue()
        || n.intValue() < 0) throw new ApiError(400, "INVALID_REQUEST", "Invalid layout version");
  }

  static double coordinate(Object value, double max) {
    if (!(value instanceof Number n)
        || !Double.isFinite(n.doubleValue())
        || Math.abs(n.doubleValue()) > max)
      throw new ApiError(400, "INVALID_REQUEST", "Invalid finite coordinate");
    return n.doubleValue();
  }

  static void fields(Map<String, Object> b, String... allowed) {
    Set<String> a = Set.of(allowed);
    if (!a.containsAll(b.keySet()))
      throw new ApiError(400, "INVALID_REQUEST", "Unknown request field");
  }

  static EditPayload editPayload(Map<String, Object> command) {
    if (!(command.get("payload") instanceof Map<?, ?> raw))
      throw new ApiError(400, "INVALID_REQUEST", "payload must be an object");
    Map<String, Object> payload = (Map<String, Object>) raw;
    return switch (str(command, "operation")) {
      case "replace_expression" -> {
        fields(payload, "field", "source");
        String field = str(payload, "field");
        if (!Set.of("expression", "condition").contains(field))
          throw new ApiError(400, "INVALID_REQUEST", "Unknown expression field");
        yield new ReplaceExpression(field, editSource(payload));
      }
      case "insert_statement" -> {
        fields(payload, "position", "source");
        String position = str(payload, "position");
        if (!Set.of("before", "after", "body_start", "body_end").contains(position))
          throw new ApiError(400, "INVALID_REQUEST", "Unknown insertion position");
        yield new InsertStatement(position, editSource(payload));
      }
      case "delete_statement" -> {
        fields(payload);
        yield new DeleteStatement();
      }
      default -> throw new ApiError(400, "INVALID_REQUEST", "Unsupported graph operation");
    };
  }

  static String editSource(Map<String, Object> payload) {
    String source = str(payload, "source");
    try {
      int size = StandardCharsets.UTF_8.newEncoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .encode(java.nio.CharBuffer.wrap(source)).remaining();
      if (size > 1048576)
        throw new ApiError(413, "INPUT_LIMIT_EXCEEDED", "Edit source limit is 1 MiB");
    } catch (CharacterCodingException e) {
      throw new ApiError(400, "INVALID_REQUEST", "Edit source must contain valid Unicode");
    }
    return source;
  }

  static int limit(int n) {
    if (n < 1 || n > 100) throw new ApiError(400, "INVALID_REQUEST", "Limit must be 1..100");
    return n;
  }

  static void profile(Map<String, Object> b) {
    if (!"java21-v1".equals(b.get("profileId")))
      throw new ApiError(400, "INVALID_REQUEST", "Unknown immutable execution profile");
  }

  static void entry(String s) {
    if (s.length() > 240 || !s.matches("[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*"))
      throw new ApiError(400, "INVALID_REQUEST", "Invalid entry point");
  }

  static void validateInput(Map<String, Object> b) {
    Object input = b.getOrDefault("stdinUtf8", "");
    if (!(input instanceof String stdin))
      throw new ApiError(400, "INVALID_REQUEST", "stdinUtf8 must be text");
    if (stdin.getBytes(StandardCharsets.UTF_8).length > 1048576)
      throw new ApiError(413, "INPUT_LIMIT_EXCEEDED", "Stdin limit");
    Object argv = b.getOrDefault("argv", List.of());
    if (!(argv instanceof List<?> args) || args.stream().anyMatch(a -> !(a instanceof String)))
      throw new ApiError(400, "INVALID_REQUEST", "Invalid argv");
    dev.javablueprints.verification.RunnerProtocol.arguments((List<String>) argv);
  }

  static Map<String, String> texts(Map<String, Object> b) {
    if (!(b.get("files") instanceof List<?> fs))
      throw new ApiError(400, "INVALID_REQUEST", "files required");
    var m = new TreeMap<String, String>();
    for (Object f : fs) {
      Map<String, Object> file = (Map<String, Object>) f;
      fields(file, "path", "content");
      String path = str(file, "path");
      if (!(file.get("content") instanceof String text))
        throw new ApiError(400, "INVALID_REQUEST", "content required");
      if (m.put(path, text) != null) throw new ApiError(400, "INVALID_REQUEST", "Duplicate file");
    }
    return m;
  }

  void binding(Map<String, Object> a, String method) {
    Map<?, ?> g = (Map<?, ?>) a.get("graph");
    if (g == null
        || ((List<?>) g.get("methods"))
            .stream().noneMatch(m -> method.equals(((Map<?, ?>) m).get("id"))))
      throw new ApiError(409, "ANALYSIS_CONFLICT", "Unknown method binding");
  }

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
    NullPointerException.class,
    org.springframework.http.converter.HttpMessageNotReadableException.class,
    org.springframework.web.bind.MissingServletRequestParameterException.class
  })
  ResponseEntity<?> bad(Exception e) {
    return error(new ApiError(400, "INVALID_REQUEST", "Invalid request shape or value"));
  }

  @ExceptionHandler(EngineException.class)
  ResponseEntity<?> engine(EngineException e) {
    return error(
        new ApiError(e.code().equals("ANALYSIS_CONFLICT") ? 409 : 422, e.code(), e.getMessage()));
  }
}
