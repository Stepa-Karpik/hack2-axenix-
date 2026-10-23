package dev.javablueprints.server;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
class WebRoutes {
  @GetMapping({"/projects/{projectId}", "/projects/{projectId}/runs/{runId}"})
  String application() {
    return "forward:/index.html";
  }
}
