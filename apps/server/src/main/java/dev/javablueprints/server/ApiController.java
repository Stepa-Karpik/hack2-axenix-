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
  final Accounts accounts;

  ApiController(Workspace w, JobWorker worker, Accounts accounts) {
    this.w = w;
    this.worker = worker;
    this.accounts = accounts;
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
            List.of("replace_expression", "replace_statement", "insert_statement", "delete_statement", "move_statement", "wrap_if", "wrap_while", "add_else", "remove_else", "optimize_membership"),
            "symbols",
            map("status", "partial", "runtimeDispatch", "unknown", "environmentHash",
                dev.javablueprints.engine.ProgramEngine.currentSymbolEnvironmentHash()),
            "condition_flow",
            map("status", "partial", "scope", "normal_short_circuit_conditions", "exceptionalFlow", "unknown"),
            "control_flow",
            map("status", "partial", "exceptionalFlow", "structured_conservative"),
            "exception_flow",
            map("status", "partial", "scope", "ordinary_try_catch_finally", "catchDispatch", "ordered_runtime_type_predicates", "finallyCompletion", "context_specific", "expressionExceptions", "conservative", "tryWithResources", "unsupported"),
            "switch_flow",
            map("status", "partial", "scope", "traditional_statement_switch", "exceptionalFlow", "unknown"),
            "enhanced_for_flow",
            map("status", "partial", "scope", "normal_iteration_abstraction", "protocolDetails", "unknown", "exceptionalFlow", "unknown"),
            "runner",
            map("available", worker.available(), "profileId", "java21-v1"),
            "limits",
            map("maxProjectBytes", 1048576, "maxProjectFiles", 100, "maxTestCases", 100),
            "unsupported",
            List.of("method_harness", "benchmark", "llm", "class_decomposition")));
  }

  @GetMapping("/session")
  Object session(HttpServletRequest req) {
    return ok(accounts.session(req));
  }

  @GetMapping("/projects")
  Object projects(@RequestParam(defaultValue = "20") int limit,
      @RequestParam(defaultValue = "") String q,
      @RequestParam(required = false) String before,
      @RequestParam(defaultValue = "default") String scope) {
    return ok(w.projects(limit(limit), q, before, scope));
  }

  @PostMapping("/projects")
  Object project(
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "name");
    return mutation(Workspace.currentActor()==null?"projects":"projects:"+Workspace.currentActor(), key, b, 201, () -> w.createProject(str(b, "name")));
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
    fields(b, "expectedHeadRevisionId", "files", "directories", "importedPaths", "importedDirectories", "intent");
    String expected = w.expected(match, b);
    if (!Objects.toString(b.getOrDefault("intent", "semantic_edit")).equals("semantic_edit"))
      throw new ApiError(400, "INVALID_REQUEST", "Text save intent must be semantic_edit");
    Map<String, String> texts = texts(b);
    List<String> directories = b.containsKey("directories") ? strings(b, "directories") : null;
    List<String> imported = strings(b, "importedPaths");
    List<String> importedDirectories = strings(b, "importedDirectories");
    if (new HashSet<>(imported).size() != imported.size() || !texts.keySet().containsAll(imported))
      throw TextTree.invalid("importedPaths must reference unique supplied files");
    return mutation(
        p + ":revision",
        key,
        map("expected", expected, "body", b),
        201,
        () -> {
          var base = expected.equals("empty") ? null : w.revision(p, expected);
          var tree = new TextTree(texts, directories == null
              ? base == null ? List.of() : w.directories(base) : directories);
          if (new HashSet<>(importedDirectories).size() != importedDirectories.size()
              || !tree.directories.containsAll(importedDirectories))
            throw TextTree.invalid("importedDirectories must reference unique supplied directories");
          if (base != null && (!imported.isEmpty() || !importedDirectories.isEmpty())) {
            var baseFiles = w.files(base);
            var occupied = new HashSet<>(baseFiles.keySet());
            occupied.addAll(w.directories(base));
            for (String path : imported) {
              if (occupied.contains(path)) throw TextTree.conflict("Import path is already occupied");
              var parents = new HashSet<String>(); TextTree.parents(path, parents);
              if (parents.stream().anyMatch(baseFiles::containsKey))
                throw TextTree.conflict("Import parent is already a file");
            }
            for (String directory : importedDirectories) {
              var parents = new HashSet<String>(); TextTree.parents(directory, parents);
              parents.add(directory);
              if (parents.stream().anyMatch(baseFiles::containsKey))
                throw TextTree.conflict("Import directory is already a file");
            }
          }
          var raw = new TreeMap<String, byte[]>();
          imported.forEach(path -> raw.put(path, TextTree.utf8(texts.get(path))));
          return w.save(p, expected, tree.files, raw, tree.directories,
              imported.isEmpty() && importedDirectories.isEmpty() ? "text_edit" : "import", "semantic_edit", true);
        });
  }

  @PostMapping(value = "/projects/{p}/import-previews", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  Object importPreview(@PathVariable String p,
      @RequestParam(value = "files", required = false) List<MultipartFile> uploads,
      @RequestParam(value = "directories", required = false) List<String> directories) throws IOException {
    w.project(p);
    return ok(TextTree.imports(uploads == null ? List.of() : uploads,
        directories == null ? List.of() : directories).preview());
  }

  @PostMapping(value = "/projects/{p}/imports", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  Object imports(
      @PathVariable String p,
      @RequestHeader(value = "If-Match", required = false) String match,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestParam(value = "files", required = false) List<MultipartFile> uploads,
      @RequestParam(value = "directories", required = false) List<String> directories,
      @RequestParam(defaultValue = "java21-v1") String languageProfileId) throws IOException {
    if (!languageProfileId.equals("java21-v1")) throw TextTree.invalid("Unknown language profile");
    String expected = w.expected(match, Map.of());
    var tree = TextTree.imports(uploads == null ? List.of() : uploads,
        directories == null ? List.of() : directories);
    var raw = new TreeMap<String, byte[]>();
    tree.files.forEach((path, text) -> raw.put(path, TextTree.utf8(text)));
    var payload = map("expected", expected, "files", tree.files, "profile", languageProfileId);
    // Keep accepted legacy multipart replay hashes stable when no new directory input is supplied.
    boolean archive = uploads != null && uploads.size() == 1 && Objects.toString(
        uploads.getFirst().getOriginalFilename(), "").toLowerCase(Locale.ROOT).endsWith(".zip");
    if (directories != null || archive) payload.put("directories", List.copyOf(tree.directories));
    return mutation(p + ":import", key,
        payload, 201,
        () -> {
          var rev = w.save(p, expected, tree.files, raw, tree.directories, "import", "semantic_edit", true);
          if (!tree.javaFiles().isEmpty()) rev.put("analysisJob", w.enqueue(p, "analyze", map("revisionId", rev.get("id"))));
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
          if (restored.get("bundleHash") != null)
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
    w.javaFiles(w.revision(p, r));
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
    var result=w.analysis(p,r,analysisId);
    if(analysisId==null && !dev.javablueprints.engine.ProgramEngine.VERSION.equals(result.get("analyzerVersion"))) throw new ApiError(409,"ANALYSIS_NOT_READY","Analysis engine updated; refresh required");
    return ok(result);
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
    var analysis = w.analysis(p, r, str(b, "analysisId"));
    if (!Set.of("semantic_edit", "preserve_behavior").contains(str(b, "intent")))
      throw new ApiError(400, "INVALID_REQUEST", "Unknown intent");
    return mutation(
        p + ":change",
        key,
        b,
        202,
        () -> {
          w.currentAnalysis(analysis);
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
    w.javaFiles(w.revision(p, str(b, "revisionId")));
    profile(b);
    worker.requireAvailable();
    return mutation(p + ":compile", key, b, 202, () -> w.enqueue(p, "compile", b));
  }

  @PostMapping("/projects/{p}/runs")
  Object run(
      @PathVariable String p,
      @RequestHeader(value = "Idempotency-Key", required = false) String key,
      @RequestBody Map<String, Object> b) {
    fields(b, "revisionId", "profileId", "entryPoint", "argv", "stdinUtf8", "interactive");
    if(b.containsKey("interactive") && !(b.get("interactive") instanceof Boolean)) throw new ApiError(400,"INVALID_REQUEST","interactive must be boolean");
    w.javaFiles(w.revision(p, str(b, "revisionId")));
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
    w.javaFiles(w.revision(p, str(b, "baseRevisionId")));
    w.javaFiles(w.revision(p, str(b, "candidateRevisionId")));
    w.resource(p, str(b, "suiteVersionId"), "suite");
    profile(b);
    worker.requireAvailable();
    return mutation(p + ":compare", key, b, 202, () -> w.enqueue(p, "compare", b));
  }

  @GetMapping({"/projects/{p}/jobs/{j}", "/projects/{p}/runs/{j}"})
  Object job(@PathVariable String p, @PathVariable String j) {
    var view=w.job(p,j);view.put("live",worker.live(p,j));view.put("progress",worker.comparisonProgress(p,j,view));return ok(view);
  }

  @PostMapping("/projects/{p}/runs/{j}/input")
  Object runInput(@PathVariable String p,@PathVariable String j,@RequestHeader("Idempotency-Key") String key,@RequestBody Map<String,Object> b) {
    fields(b,"text","eof");
    if(!(b.get("text") instanceof String text) || !(b.get("eof") instanceof Boolean eof)) throw new ApiError(400,"INVALID_REQUEST","text and eof required");
    if(text.getBytes(StandardCharsets.UTF_8).length>8192) throw new ApiError(413,"INPUT_LIMIT_EXCEEDED","Input line limit is8KiB");
    return ok(worker.input(p,j,key,text,eof));
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
    fields(b, "revisionId", "includeReportIds", "paths");
    var rev = w.revision(p, str(b, "revisionId"));
    var selection = b.containsKey("paths") ? strings(b, "paths") : null;
    var sourceFiles = w.files(rev);
    var sourceDirectories = w.directories(rev);
    if (selection != null) {
      if (selection.isEmpty() || new HashSet<>(selection).size() != selection.size())
        throw TextTree.invalid("Export selection must contain unique paths");
      for (String path : selection) {
        TextTree.path(path);
        if (!sourceFiles.containsKey(path) && !sourceDirectories.contains(path)) throw missing();
      }
    }
    return mutation(
        p + ":export",
        key,
        b,
        201,
        () -> {
          try {
            var bytes = new ByteArrayOutputStream();
            try (var zip = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
              for (String directory : sourceDirectories) {
                if (!selected(selection, directory)) continue;
                zip.putNextEntry(new ZipEntry(directory + "/")); zip.closeEntry();
              }
              var exportedPaths = new HashSet<>(sourceFiles.keySet());
              for (var file : sourceFiles.entrySet()) {
                if (!selected(selection, file.getKey())) continue;
                zip.putNextEntry(new ZipEntry(file.getKey()));
                zip.write(file.getValue().getBytes(StandardCharsets.UTF_8));
                zip.closeEntry();
              }
              for (Object report : (List<?>) b.getOrDefault("includeReportIds", List.of())) {
                var result = w.resource(p, report.toString(), "comparison");
                String path = "reports/" + uuid(report.toString()) + ".json";
                if (!exportedPaths.add(path) || w.directories(rev).contains(path)
                    || w.files(rev).containsKey("reports"))
                  throw TextTree.conflict("Report export path is occupied by source");
                zip.putNextEntry(new ZipEntry(path));
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
      case "replace_statement" -> { fields(payload,"source");yield new ReplaceStatement(editSource(payload)); }
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
      case "move_statement" -> {
        fields(payload, "targetNodeId", "position");
        String position = str(payload, "position");
        if (!Set.of("before", "after").contains(position))
          throw new ApiError(400, "INVALID_REQUEST", "Unknown move position");
        yield new MoveStatement(str(payload, "targetNodeId"), position);
      }
      case "wrap_if", "wrap_while" -> {
        fields(payload, "condition");
        yield new WrapStatement(editSource(Map.of("source", str(payload, "condition"))));
      }
      case "add_else" -> {
        fields(payload, "source");
        yield new AddElse(editSource(payload));
      }
      case "remove_else" -> {
        fields(payload);
        yield new RemoveElse();
      }
        case "optimize_membership" -> {
          fields(payload);
          if (!"preserve_behavior".equals(command.get("intent")))
            throw new ApiError(400,"INVALID_REQUEST","Optimization requires preserve_behavior");
          yield new OptimizeMembership();
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

  static boolean selected(List<String> selection, String path) {
    return selection == null || selection.stream().anyMatch(p -> path.equals(p) || path.startsWith(p + "/"));
  }

  static List<String> strings(Map<String, Object> body, String field) {
    Object value = body.getOrDefault(field, List.of());
    if (!(value instanceof List<?> list) || list.stream().anyMatch(item -> !(item instanceof String)))
      throw TextTree.invalid(field + " must be an array of paths");
    return (List<String>) list;
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
