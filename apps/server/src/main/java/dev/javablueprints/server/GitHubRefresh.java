package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static dev.javablueprints.server.GitHubClient.*;
import jakarta.servlet.http.HttpServletRequest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;

/** Persisted single-flight rotation. Provider I/O never holds account/credential row locks. */
final class GitHubRefresh {
  static final String ROW="SELECT l.github_id,c.token_ciphertext,c.grant_version::text,c.expires_at,c.granted_scopes,c.refresh_ciphertext,c.refresh_expires_at,c.token_version::text,c.refresh_owner::text,c.refresh_lease_until,c.refresh_reconnect FROM github_links l JOIN github_credentials c ON c.account_id=l.account_id WHERE l.account_id=? FOR UPDATE OF c";
  final Workspace w; final Accounts accounts; final GitHubConfig config; final GitHubClient client;
  GitHubRefresh(Workspace w,Accounts accounts,GitHubConfig config,GitHubClient client){this.w=w;this.accounts=accounts;this.config=config;this.client=client;}
  record Claim(Map<String,Object> row,String owner,ApiError failure){}
  static Timestamp timestamp(Instant instant){return instant==null?null:Timestamp.from(instant);}
  private GitHubCrypto crypto(){return new GitHubCrypto(config.key);}
  private ApiError reconnect(){return error(401,"GITHUB_RECONNECT","GitHub token rotation needs repository reconnection");}
  private static Instant instant(Object value){return value==null?null:((Timestamp)value).toInstant();}
  private void session(HttpServletRequest request,String actor,String sessionId,int version){
    boolean same=false;
    try{same=request.getSession(false)!=null&&sessionId.equals(request.getSession(false).getId())&&actor.equals(accounts.actor(request));}catch(IllegalStateException ignored){}
    if(!same||version!=w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",Integer.class,uuid(actor)))throw error(409,"GITHUB_SESSION_CHANGED","Account session or credentials changed; reconnect");
  }
  GitHubService.Credential credential(HttpServletRequest request){
    config.require();String actor=accounts.require(request);
    var httpSession=request.getSession(false);if(httpSession==null)throw error(401,"AUTH_REQUIRED","Sign in before GitHub access");
    String sessionId=httpSession.getId();
    int version=w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=?",Integer.class,uuid(actor));
    Claim claim=w.tx.execute(tx->{
      session(request,actor,sessionId,version);
      var rows=w.db.queryForList(ROW,uuid(actor));
      if(rows.isEmpty())throw error(409,"GITHUB_REPOSITORY_ACCESS_REQUIRED","Connect repository access in GitHub settings");
      var row=rows.getFirst();Instant now=Instant.now();
      if(Boolean.TRUE.equals(row.get("refresh_reconnect")))return new Claim(row,null,reconnect());
      if(!GitHubService.scopes(row.get("granted_scopes")).contains("repo"))throw error(403,"GITHUB_SCOPE_REQUIRED","GitHub repository access is required");
      if(row.get("refresh_owner")!=null){
        if(instant(row.get("refresh_lease_until")).isAfter(now))return new Claim(row,null,error(409,"GITHUB_REFRESH_PENDING","Repository token refresh is in progress; retry shortly"));
        // A crashed/unknown rotation may already have consumed the one-use refresh token.
        w.db.update("UPDATE github_credentials SET refresh_reconnect=true,refresh_owner=NULL,refresh_lease_until=NULL WHERE account_id=? AND token_version=?::uuid",uuid(actor),row.get("token_version"));
        return new Claim(row,null,reconnect());
      }
      Instant expires=instant(row.get("expires_at"));
      boolean refreshable=row.get("refresh_ciphertext")!=null&&instant(row.get("refresh_expires_at")).isAfter(now);
      if(expires==null||expires.isAfter(now.plusSeconds(60))||expires.isAfter(now)&&!refreshable)return new Claim(row,null,null);
      if(!refreshable)return new Claim(row,null,reconnect());
      String owner=id();
      int changed=w.db.update("UPDATE github_credentials SET refresh_owner=?::uuid,refresh_lease_until=now()+interval '60 seconds' WHERE account_id=? AND grant_version=?::uuid AND token_version=?::uuid AND refresh_owner IS NULL AND refresh_reconnect=false",owner,uuid(actor),row.get("grant_version"),row.get("token_version"));
      if(changed!=1)throw error(409,"GITHUB_REFRESH_PENDING","Repository token refresh is in progress; retry shortly");
      return new Claim(row,owner,null);
    });
    if(claim.failure()!=null)throw claim.failure();
    var row=claim.row();String githubId=row.get("github_id").toString(),grant=row.get("grant_version").toString();
    if(claim.owner()==null)return new GitHubService.Credential(actor,githubId,crypto().open(row.get("token_ciphertext").toString(),"repository|"+actor+"|"+githubId),grant);
    try{
      String refresh=crypto().open(row.get("refresh_ciphertext").toString(),"repository-refresh|"+actor+"|"+githubId);
      var pair=tokenPair(client.refresh(config,refresh),true);
      if(!GitHubService.scopes(pair.scope()).equals(GitHubService.scopes(row.get("granted_scopes"))))throw error(403,"GITHUB_SCOPE_REQUIRED","GitHub repository authorization changed; reconnect");
      var identity=object(client.get("/user",pair.access(),65536));
      if(!githubId.equals(numeric(identity.get("id"))))throw error(409,"GITHUB_ACCOUNT_MISMATCH","GitHub identity changed; reconnect");
      w.tx.executeWithoutResult(tx->{
        session(request,actor,sessionId,version);
        var current=w.db.queryForList(ROW,uuid(actor));
        if(current.isEmpty()||!githubId.equals(current.getFirst().get("github_id")))throw reconnect();
        var active=current.getFirst();
        if(!grant.equals(active.get("grant_version"))||!row.get("token_version").equals(active.get("token_version"))||!claim.owner().equals(active.get("refresh_owner"))||Boolean.TRUE.equals(active.get("refresh_reconnect"))||!instant(active.get("refresh_lease_until")).isAfter(Instant.now()))throw reconnect();
        int changed=w.db.update("UPDATE github_credentials SET token_ciphertext=?,refresh_ciphertext=?,expires_at=?,refresh_expires_at=?,token_version=?::uuid,refresh_owner=NULL,refresh_lease_until=NULL,refresh_reconnect=false,updated_at=now() WHERE account_id=? AND grant_version=?::uuid AND token_version=?::uuid AND refresh_owner=?::uuid",
            crypto().seal(pair.access(),"repository|"+actor+"|"+githubId),crypto().seal(pair.refresh(),"repository-refresh|"+actor+"|"+githubId),timestamp(pair.expires()),timestamp(pair.refreshExpires()),id(),uuid(actor),grant,row.get("token_version"),claim.owner());
        if(changed!=1)throw reconnect();
      });
      return new GitHubService.Credential(actor,githubId,pair.access(),grant);
    }catch(RuntimeException failure){
      // Never clear a newer grant or recreate a credential deleted by unlink.
      try{w.tx.executeWithoutResult(tx->{
        w.db.queryForList("SELECT id FROM accounts WHERE id=? FOR UPDATE",uuid(actor));
        w.db.update("UPDATE github_credentials SET refresh_reconnect=true,refresh_owner=NULL,refresh_lease_until=NULL WHERE account_id=? AND grant_version=?::uuid AND token_version=?::uuid AND refresh_owner=?::uuid",uuid(actor),grant,row.get("token_version"),claim.owner());
      });}catch(RuntimeException ignored){/* Persisted claim remains: lease expiry requires reconnect. */}
      throw failure instanceof ApiError?failure:reconnect();
    }
  }
}
