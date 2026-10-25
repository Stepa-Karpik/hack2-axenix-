package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.HttpServletRequest;
import java.util.*;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/assistant")
class AssistantController {
  final Accounts accounts;
  final AssistantService assistant;

  AssistantController(Accounts accounts, AssistantService assistant) {
    this.accounts = accounts;
    this.assistant = assistant;
  }

  Object ok(Object data) {
    return map("data", data, "meta", map("requestId", id()));
  }

  @GetMapping("/status")
  Object status(HttpServletRequest r) {
    accounts.require(r);
    return ok(
        map("configured", assistant.provider.configured(), "model", assistant.provider.model));
  }

  @PostMapping("/projects/{project}/code-proposals/{proposal}/refresh")
  Object refreshCodeProposal(@PathVariable String project,@PathVariable String proposal,HttpServletRequest r) {
    return ok(new AssistantCodeProposals(assistant.w).refresh(accounts.require(r),project,proposal));
  }

  @GetMapping("/conversations")
  Object list(HttpServletRequest r) {
    return ok(assistant.list(accounts.require(r)));
  }

  @PostMapping("/conversations")
  Object create(HttpServletRequest r) {
    return ok(assistant.create(accounts.require(r)));
  }

  @GetMapping("/conversations/{cid}")
  Object get(@PathVariable String cid, HttpServletRequest r) {
    return ok(assistant.conversation(accounts.require(r), cid));
  }

  @DeleteMapping("/conversations/{cid}")
  Object delete(@PathVariable String cid, HttpServletRequest r) {
    return ok(assistant.delete(accounts.require(r), cid));
  }

  @PostMapping("/conversations/{cid}/messages")
  Object send(
      @PathVariable String cid, @RequestBody Map<String, Object> body, HttpServletRequest r) {
    return ok(assistant.send(accounts.require(r), cid, body));
  }

  @PostMapping("/conversations/{cid}/actions/{aid}")
  Object act(
      @PathVariable String cid,
      @PathVariable String aid,
      @RequestBody(required = false) Map<String, Object> body,
      HttpServletRequest r) {
    return ok(assistant.act(accounts.require(r), cid, aid, body == null ? map() : body));
  }

  @PostMapping("/conversations/{cid}/actions/{aid}/result")
  Object result(
      @PathVariable String cid,
      @PathVariable String aid,
      @RequestBody Map<String, Object> body,
      HttpServletRequest r) {
    return ok(assistant.result(accounts.require(r), cid, aid, body));
  }

  @PostMapping("/conversations/{cid}/actions/{aid}/cancel")
  Object cancel(@PathVariable String cid, @PathVariable String aid, HttpServletRequest r) {
    return ok(assistant.cancel(accounts.require(r), cid, aid));
  }
}
