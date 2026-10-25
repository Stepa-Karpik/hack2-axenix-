package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import java.util.*;

/** Account commands use the same permissions and mutations as the ordinary account UI. */
final class AssistantSocialActions {
  static final Set<String> TYPES=Set.of("friend_request","friend_accept","friend_decline","friend_remove","project_role");
  final AccountController accounts;
  final Workspace w;
  AssistantSocialActions(AccountController accounts) { this.accounts=accounts; this.w=accounts.w; }

  Map<String,Object> snapshot(String actor,String type,Map<String,Object> args) {
    if(type.equals("friend_accept") || type.equals("friend_decline")) {
      var rows=w.db.queryForList("SELECT id::text,sender_id::text,recipient_id::text,created_at::text FROM friend_requests WHERE id=?",uuid(str(args,"requestId")));
      if(rows.isEmpty()) throw missing();
      var row=rows.getFirst();
      if(!actor.equals(row.get("recipient_id"))) throw new ApiError(403,"ACCESS_DENIED","Only recipient can respond");
      return map("social",row);
    }
    String target=accounts.a.byUsername(str(args,"username"));
    if(actor.equals(target)) throw new ApiError(400,"INVALID_REQUEST","Cannot target yourself");
    var state=map("targetId",target,"username",str(args,"username"));
    state.put("friendships",w.db.queryForList("SELECT created_at::text FROM friendships WHERE first_id=least(?::uuid,?::uuid) AND second_id=greatest(?::uuid,?::uuid)",actor,target,actor,target));
    if(type.equals("friend_request")) {
      if(accounts.friends(actor,target)) throw new ApiError(409,"ALREADY_FRIENDS","Already friends");
      state.put("requests",w.db.queryForList("SELECT id::text,sender_id::text,recipient_id::text FROM friend_requests WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id",uuid(actor),uuid(target),uuid(target),uuid(actor)));
      if(!((List<?>)state.get("requests")).isEmpty()) throw new ApiError(409,"REQUEST_EXISTS","Request already exists");
    }
    if(type.equals("friend_remove") && !accounts.friends(actor,target)) throw new ApiError(409,"NOT_FRIENDS","Friendship no longer exists");
    if(type.equals("project_role")) {
      String project=str(args,"projectId");
      accounts.ownerActor(project,actor);
      state.put("membership",w.db.queryForList("SELECT role FROM project_members WHERE project_id=? AND account_id=?",uuid(project),uuid(target)));
      if(!str(args,"role").equals("remove") && !accounts.friends(actor,target)) throw new ApiError(409,"FRIEND_REQUIRED","Friend required");
      if(str(args,"role").equals("remove") && ((List<?>)state.get("membership")).isEmpty()) throw new ApiError(409,"MEMBER_REQUIRED","Membership no longer exists");
    }
    return map("social",state);
  }

  void execute(String actor,String type,Map<String,Object> args,Map<String,Object> binding) {
    // Lock both accounts in deterministic order, then relevant rows. Changes made by the
    // normal UI are detected again by the exact snapshot and existing mutation checks.
    Map<?,?> state=(Map<?,?>)binding.get("social");
    String target=Objects.toString(state.get(type.startsWith("friend_a")||type.equals("friend_decline") ? "sender_id" : "targetId"),actor);
    w.db.queryForList("SELECT id FROM accounts WHERE id IN (?,?) ORDER BY id FOR UPDATE",uuid(actor),uuid(target));
    if(type.equals("friend_accept")||type.equals("friend_decline"))
      w.db.queryForList("SELECT id FROM friend_requests WHERE id=? FOR UPDATE",uuid(str(args,"requestId")));
    else {
      w.db.queryForList("SELECT first_id FROM friendships WHERE first_id=least(?::uuid,?::uuid) AND second_id=greatest(?::uuid,?::uuid) FOR UPDATE",actor,target,actor,target);
      if(type.equals("project_role")) w.db.queryForList("SELECT account_id FROM project_members WHERE project_id=? AND account_id=? FOR UPDATE",uuid(str(args,"projectId")),uuid(target));
    }
    try {
      if(!Objects.equals(binding.get("social"),snapshot(actor,type,args).get("social"))) throw AssistantService.stale();
    } catch(ApiError e) {
      if(e.status==404 || e.code.equals("ALREADY_FRIENDS") || e.code.equals("NOT_FRIENDS") || e.code.equals("REQUEST_EXISTS") || e.code.equals("MEMBER_REQUIRED")) throw AssistantService.stale();
      throw e;
    }
    switch(type) {
      case "friend_request" -> accounts.inviteActor(actor,str(args,"username"));
      case "friend_accept", "friend_decline" -> accounts.respondActor(actor,str(args,"requestId"),type.equals("friend_accept")?"accept":"decline");
      case "friend_remove" -> accounts.removeFriendActor(actor,target);
      case "project_role" -> {
        String project=str(args,"projectId"),role=str(args,"role");
        if(role.equals("remove")) accounts.removeMemberActor(project,actor,target);
        else accounts.memberActor(project,actor,str(args,"username"),role);
      }
      default -> throw AssistantActions.invalid();
    }
  }
}
