package dev.javablueprints.server;

import org.springframework.http.MediaType;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
class WebRoutes {
  @GetMapping(
      value = {
        "/projects/{projectId}",
        "/projects/{projectId}/runs/{runId}",
        "/login",
        "/register",
        "/forgot-password",
        "/reset-password",
        "/verify-email",
        "/auth/login",
        "/auth/register",
        "/auth/forgot-password",
        "/auth/reset-password",
        "/auth/verify-email",
        "/settings",
        "/account",
        "/friends",
        "/u/{username}",
        "/profile/{username}"
      },
      produces = MediaType.TEXT_HTML_VALUE)
  String application() {
    return "forward:/index.html";
  }
}
