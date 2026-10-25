package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.util.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/github")
final class GitHubController {
  final GitHubService service;final GitHubRepositoryService repositories;
  GitHubController(GitHubService service,GitHubRepositoryService repositories){this.service=service;this.repositories=repositories;}
  Map<String,Object> ok(Object data){return map("data",data,"meta",map("requestId",id()));}
  @GetMapping("/status") Object status(HttpServletRequest request){return ok(service.status(request));}
  @PostMapping("/oauth/start") Object start(@RequestBody Map<String,Object> body,HttpServletRequest request){ApiController.fields(body,"purpose");return ok(service.start(request,str(body,"purpose")));}
  @GetMapping("/oauth/callback") ResponseEntity<?> callback(HttpServletRequest request,@RequestParam(required=false)String state,@RequestParam(required=false)String code,@RequestParam(required=false)String error){
    String destination;
    try{destination=service.callback(request,state,code,error);}catch(ApiError failure){String prefix=service.accounts.actor(request)==null?"/login":"/settings/integrations";destination=prefix+"?github="+GitHubClient.segment(failure.code);}
    return ResponseEntity.status(303).location(URI.create(destination)).header("Cache-Control","no-store").header("Referrer-Policy","no-referrer").build();
  }
  @DeleteMapping("/link") Object unlink(HttpServletRequest request){service.unlink(request);return ok(map("disconnected",true,"providerGrantRevoked",false));}
  @GetMapping("/repositories") Object repositories(HttpServletRequest request,@RequestParam(defaultValue="1")int page){return ok(repositories.repositories(request,page));}
  @GetMapping("/repositories/{id}/refs") Object refs(HttpServletRequest request,@PathVariable String id,@RequestParam(defaultValue="branches")String kind,@RequestParam(defaultValue="1")int page){return ok(repositories.refs(request,id,kind,page));}
  @PostMapping("/snapshots") Object snapshot(HttpServletRequest request,@RequestBody Map<String,Object> body){ApiController.fields(body,"repositoryId","ref");return ok(repositories.snapshot(request,str(body,"repositoryId"),str(body,"ref")));}
  @GetMapping("/snapshots/{id}/tree") Object tree(HttpServletRequest request,@PathVariable String id,@RequestParam(defaultValue="")String path){return ok(repositories.tree(request,id,path));}
  @PostMapping("/import-previews") Object preview(HttpServletRequest request,@RequestBody Map<String,Object> body){
    ApiController.fields(body,"snapshotId","paths","folders","allText");
    if(!(body.get("allText") instanceof Boolean all))throw new ApiError(400,"INVALID_REQUEST","allText must be boolean");
    return ok(repositories.preview(request,str(body,"snapshotId"),paths(body.get("paths")),paths(body.get("folders")),all));
  }
  static List<String> paths(Object value){if(!(value instanceof List<?> list)||list.size()>TextTree.MAX_ENTRIES||list.stream().anyMatch(v->!(v instanceof String)))throw new ApiError(400,"INVALID_REQUEST","Expected bounded path list");return (List<String>)list;}
  @ExceptionHandler(ApiError.class) ResponseEntity<?> failure(ApiError error){return ResponseEntity.status(error.status).body(map("error",map("code",error.code,"message",error.getMessage(),"details",List.of()),"meta",map("requestId",id())));}
}
