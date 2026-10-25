package dev.javablueprints.server;

import org.springframework.http.MediaType;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
class WebRoutes {
  @GetMapping(value = "/", produces = MediaType.TEXT_HTML_VALUE)
  String landing() {
    return "forward:/landing/index.html";
  }

  @GetMapping(
      value = {
        "/projects",
        "/github/complete",
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
        "/settings/profile",
        "/settings/security",
        "/settings/appearance",
        "/settings/friends",
        "/settings/integrations",
        "/account",
        "/friends",
        "/u/{username}",
        "/u/{username}/friends",
        "/profile/{username}",
        "/profile/{username}/friends"
      },
      produces = MediaType.TEXT_HTML_VALUE)
  String application() {
    return "forward:/index.html";
  }
}
