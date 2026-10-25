package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.*;
import org.springframework.web.servlet.config.annotation.*;

/** One authorization boundary covers revisions, imports, exports, artifacts and jobs alike. */
@Component
class ProjectAccess implements HandlerInterceptor, WebMvcConfigurer {
  final Accounts accounts;
  final Workspace w;

  ProjectAccess(Accounts accounts, Workspace w) {
    this.accounts = accounts;
    this.w = w;
  }

  @Override
  public void addInterceptors(InterceptorRegistry registry) {
    registry.addInterceptor(this).addPathPatterns("/api/v1/**");
  }

  @Override
  public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) {
    String actor = accounts.actor(req);
    req.setAttribute("accountId", actor);
    String path = req.getRequestURI().substring(req.getContextPath().length());
    String prefix = "/api/v1/projects/";
    if (!path.startsWith(prefix)) return true;
    String project = path.substring(prefix.length()).split("/", 2)[0];
    var rows =
        w.db.queryForList(
            "SELECT owner_id::text,visibility FROM projects WHERE id=?", uuid(project));
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    if (row.get("owner_id") == null)
      return true; // Explicitly local compatibility workspace, never a private account project.
    boolean owner = Objects.equals(actor, row.get("owner_id"));
    String role =
        actor == null
            ? null
            : w
                .db
                .queryForList(
                    "SELECT role FROM project_members WHERE project_id=? AND account_id=?",
                    uuid(project),
                    uuid(actor))
                .stream()
                .map(r -> r.get("role").toString())
                .findFirst()
                .orElse(null);
    boolean read = Set.of("GET", "HEAD", "OPTIONS").contains(req.getMethod());
    // Source export only materializes an artifact from already-readable snapshots. It cannot run
    // code or modify source/head; every other POST still requires owner/editor permission.
    boolean sourceExport =
        req.getMethod().equals("POST") && (path.equals(prefix + project + "/exports")
            || path.equals(prefix + project + "/archives"));
    if (sourceExport && (owner || role != null || row.get("visibility").equals("public")))
      return true;
    if (read && (owner || role != null || row.get("visibility").equals("public"))) return true;
    if (!read && (owner || "editor".equals(role))) return true;
    throw new ApiError(
        actor == null ? 401 : 403,
        actor == null ? "AUTH_REQUIRED" : "ACCESS_DENIED",
        "Project access denied");
  }
}
