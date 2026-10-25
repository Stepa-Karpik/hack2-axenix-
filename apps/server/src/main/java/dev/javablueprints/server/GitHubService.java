package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static dev.javablueprints.server.GitHubClient.*;
import jakarta.servlet.http.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

@Service
final class GitHubService {
  final Workspace w; final Accounts accounts; final GitHubConfig config; final GitHubClient client;
  record Credential(String account,String githubId,String token,String version){}
  GitHubService(Workspace w,Accounts accounts,GitHubConfig config,GitHubClient client){this.w=w;this.accounts=accounts;this.config=config;this.client=client;}
  private GitHubCrypto crypto(){config.require();return new GitHubCrypto(config.key);}
  static Set<String> scopes(Object value){return new HashSet<>(Arrays.asList(Objects.toString(value,"").split("[, ]+")));}
  private String correlation(HttpServletRequest request,boolean create){
    var session=request.getSession(create);
    if(session==null)throw error(400,"GITHUB_STATE_INVALID","GitHub authorization session is missing; start again");
    Object value=session.getAttribute("githubCorrelation");
    if(value==null&&create){value=AccountPasswords.token();session.setAttribute("githubCorrelation",value);}
    if(!(value instanceof String))throw error(400,"GITHUB_STATE_INVALID","GitHub authorization session is missing; start again");
    return hash(value.toString());
  }
  String sessionBinding(HttpServletRequest request){return correlation(request,true);}
  int authVersion(String account){return w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=?",Integer.class,uuid(account));}
  Map<String,Object> status(HttpServletRequest request){
    String actor=accounts.actor(request);Map<String,Object> linked=null;boolean access=false;Object expires=null;
    if(actor!=null){
      var rows=w.db.queryForList("SELECT l.github_id,l.login,c.granted_scopes,c.expires_at,c.refresh_expires_at,c.refresh_reconnect FROM github_links l LEFT JOIN github_credentials c ON c.account_id=l.account_id WHERE l.account_id=?",uuid(actor));
      if(!rows.isEmpty()){
        var row=rows.getFirst();linked=map("githubId",row.get("github_id"),"login",row.get("login"));
        expires=row.get("expires_at");access=config.configured()&&row.get("granted_scopes")!=null&&scopes(row.get("granted_scopes")).contains("repo")&&!Boolean.TRUE.equals(row.get("refresh_reconnect"))&&(expires==null||((Timestamp)expires).toInstant().isAfter(Instant.now())||row.get("refresh_expires_at") instanceof Timestamp refreshExpiry&&refreshExpiry.toInstant().isAfter(Instant.now()));
      }
    }
    return map("configured",config.configured(),"unavailableReason",config.unavailableReason,"linked",linked,"repositoryAccess",access,"expiresAt",expires==null?null:((Timestamp)expires).toInstant().toString());
  }
  Map<String,Object> start(HttpServletRequest request,String purpose){
    config.require();if(!Set.of("link","login","repositories").contains(purpose))throw error(400,"INVALID_REQUEST","Unknown GitHub authorization purpose");
    String actor=accounts.actor(request);
    if(purpose.equals("login")&&actor!=null)throw error(409,"GITHUB_ALREADY_SIGNED_IN","Sign out before GitHub login");
    if(!purpose.equals("login")&&actor==null)throw error(401,"AUTH_REQUIRED","Sign in before linking GitHub");
    if(purpose.equals("repositories")&&w.db.queryForList("SELECT github_id FROM github_links WHERE account_id=?",uuid(actor)).isEmpty())throw error(409,"GITHUB_LINK_REQUIRED","Link GitHub in your profile first");
    accounts.throttle("github-start",request.getRemoteAddr(),30);
    String binding=correlation(request,true),state=AccountPasswords.token(),stateHash=hash(state),verifier=AccountPasswords.token();
    int version=actor==null?0:authVersion(actor);
    w.tx.executeWithoutResult(tx->{
      // Keep authenticated attempt creation in the same account-before-attempt lock order as unlink/callback.
      if(actor!=null){
        int current=w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",Integer.class,uuid(actor));
        if(current!=version||!actor.equals(accounts.actor(request)))throw error(409,"GITHUB_SESSION_CHANGED","Account credentials changed; start again");
      }
      w.db.update("DELETE FROM github_signup_claims WHERE expires_at<now() OR session_hash=?",binding);
      w.db.update("DELETE FROM github_oauth_attempts WHERE expires_at<now() OR (session_hash=? AND purpose=?)",binding,purpose);
      Integer total=w.db.queryForObject("SELECT count(*) FROM github_oauth_attempts",Integer.class);
      if(total>=10000)throw error(429,"GITHUB_RATE_LIMITED","Too many pending GitHub authorizations");
      w.db.update("INSERT INTO github_oauth_attempts(state_hash,session_hash,purpose,account_id,auth_version,verifier_ciphertext,expires_at) VALUES(?,?,?,?::uuid,?,?,now()+interval '10 minutes')",
          stateHash,binding,purpose,actor,actor==null?null:version,crypto().seal(verifier,"pkce|"+stateHash));
    });
    String challenge;
    try{challenge=Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));}
    catch(Exception ignored){throw error(503,"GITHUB_UNAVAILABLE","PKCE is unavailable");}
    String url="https://github.com/login/oauth/authorize?client_id="+segment(config.clientId)+"&redirect_uri="+segment(config.callback)+"&state="+segment(state)+"&code_challenge="+segment(challenge)+"&code_challenge_method=S256&allow_signup=false&prompt=select_account&scope="+(purpose.equals("login")?"":"repo");
    return map("authorizationUrl",url);
  }
  String callback(HttpServletRequest request,String state,String code,String denial){
    config.require();
    if(state==null||!state.matches("[A-Za-z0-9_-]{43}"))throw error(400,"GITHUB_STATE_INVALID","GitHub authorization state is invalid; start again");
    String binding=correlation(request,false),stateHash=hash(state);
    var attempts=w.db.queryForList("UPDATE github_oauth_attempts SET consumed_at=now() WHERE state_hash=? AND session_hash=? AND consumed_at IS NULL AND expires_at>now() RETURNING purpose,account_id::text,auth_version,verifier_ciphertext",stateHash,binding);
    if(attempts.size()!=1)throw error(400,"GITHUB_STATE_INVALID","GitHub authorization expired or was already used");
    var attempt=attempts.getFirst();String purpose=attempt.get("purpose").toString(),actor=(String)attempt.get("account_id");
    checkActor(request,actor,attempt.get("auth_version"));
    if(denial!=null)throw error(400,"GITHUB_AUTH_DENIED","GitHub authorization was not granted");
    if(code==null||code.isBlank()||code.length()>1024||code.chars().anyMatch(c->c<33||c>126))throw error(400,"GITHUB_AUTH_FAILED","GitHub authorization code is invalid");
    String verifier=crypto().open(attempt.get("verifier_ciphertext").toString(),"pkce|"+stateHash);
    var token=client.exchange(config,code,verifier);String access=token.get("access_token").toString();
    var provider=object(client.get("/user",access,65536));String githubId=numeric(provider.get("id")),login=Objects.toString(provider.get("login"),"");
    if(!login.matches("[A-Za-z0-9-]{1,100}"))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub user identity");
    checkActor(request,actor,attempt.get("auth_version"));
    if(purpose.equals("login")){
      var links=w.db.queryForList("SELECT account_id::text FROM github_links WHERE github_id=?",githubId);
      if(links.isEmpty()){
        w.tx.executeWithoutResult(tx->{
          checkActor(request,null,null);
          if(!binding.equals(correlation(request,false)))throw error(400,"GITHUB_STATE_INVALID","GitHub authorization session changed; start again");
          var active=w.db.queryForList("SELECT state_hash FROM github_oauth_attempts WHERE state_hash=? AND session_hash=? AND consumed_at IS NOT NULL AND expires_at>now() FOR UPDATE",stateHash,binding);
          if(active.size()!=1)throw error(400,"GITHUB_STATE_INVALID","GitHub authorization expired; start again");
          w.db.update("DELETE FROM github_signup_claims WHERE expires_at<now()");
          w.db.update("INSERT INTO github_signup_claims(session_hash,github_id,login,expires_at) VALUES(?,?,?,now()+interval '10 minutes') ON CONFLICT(session_hash) DO UPDATE SET github_id=EXCLUDED.github_id,login=EXCLUDED.login,expires_at=EXCLUDED.expires_at",binding,githubId,login);
        });
        if(validSignupUsername(login)){
          try{completeSignup(request,login);return "/projects?github=signup_success";}
          catch(ApiError failure){if(!failure.code.equals("ACCOUNT_CONFLICT"))throw failure;}
        }
        return "/github/complete";
      }
      String account=links.getFirst().get("account_id").toString();
      w.tx.executeWithoutResult(tx->{
        int current=w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",Integer.class,uuid(account));
        var locked=w.db.queryForList("SELECT github_id FROM github_links WHERE account_id=? FOR UPDATE",uuid(account));
        if(locked.isEmpty()||!githubId.equals(locked.getFirst().get("github_id")))throw error(401,"GITHUB_NOT_LINKED","GitHub link changed; start again");
        if(accounts.actor(request)!=null)throw error(409,"GITHUB_SESSION_CHANGED","Account session changed; start again");
        accounts.signIn(request,account,current);
      });
      return "/projects?github=login_success";
    }
    try {
      w.tx.executeWithoutResult(tx->{
        int current=w.db.queryForObject("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",Integer.class,uuid(actor));
        checkActor(request,actor,attempt.get("auth_version"));
        if(current!=((Number)attempt.get("auth_version")).intValue())throw error(409,"GITHUB_SESSION_CHANGED","Account credentials changed; start again");
        requireActiveAttempt(request,stateHash,binding,purpose,actor,current);
        var links=w.db.queryForList("SELECT github_id FROM github_links WHERE account_id=? FOR UPDATE",uuid(actor));
        if(!links.isEmpty()&&!githubId.equals(links.getFirst().get("github_id")))throw error(409,"GITHUB_ACCOUNT_MISMATCH","GitHub account differs from the linked identity; unlink explicitly first");
        if(!scopes(token.get("scope")).contains("repo"))throw error(403,"GITHUB_SCOPE_REQUIRED","GitHub repository access was not granted");
        var pair=tokenPair(token,false);
        if(purpose.equals("link")){
          w.db.update("INSERT INTO github_links(account_id,github_id,login) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET login=EXCLUDED.login",uuid(actor),githubId,login);
        }else if(links.isEmpty())throw error(409,"GITHUB_LINK_REQUIRED","GitHub link changed; reconnect from profile");
        persistRepositoryGrant(actor,githubId,pair);
      });
    }catch(DuplicateKeyException ignored){throw error(409,"GITHUB_LINK_CONFLICT","This GitHub identity is already linked to another account");}
    return "/settings/integrations?github="+(purpose.equals("link")?"link_success":"repositories_success");
  }
  private void persistRepositoryGrant(String actor,String githubId,TokenPair pair){
    w.db.update("INSERT INTO github_credentials(account_id,token_ciphertext,granted_scopes,grant_version,expires_at,refresh_ciphertext,refresh_expires_at,token_version) VALUES(?,?,?,?::uuid,?,?,?,?::uuid) ON CONFLICT(account_id) DO UPDATE SET token_ciphertext=EXCLUDED.token_ciphertext,granted_scopes=EXCLUDED.granted_scopes,grant_version=EXCLUDED.grant_version,expires_at=EXCLUDED.expires_at,refresh_ciphertext=EXCLUDED.refresh_ciphertext,refresh_expires_at=EXCLUDED.refresh_expires_at,token_version=EXCLUDED.token_version,refresh_owner=NULL,refresh_lease_until=NULL,refresh_reconnect=false,updated_at=now()",
        uuid(actor),crypto().seal(pair.access(),"repository|"+actor+"|"+githubId),pair.scope(),id(),GitHubRefresh.timestamp(pair.expires()),
        pair.refresh()==null?null:crypto().seal(pair.refresh(),"repository-refresh|"+actor+"|"+githubId),GitHubRefresh.timestamp(pair.refreshExpires()),id());
  }
  private void requireActiveAttempt(HttpServletRequest request,String stateHash,String binding,String purpose,String actor,int version){
    // The provider request runs outside our transaction. Unlink may cancel the consumed attempt
    // during that request; account lock + this row lock linearize cancellation before any write.
    if(!binding.equals(correlation(request,false)))throw error(400,"GITHUB_STATE_INVALID","GitHub authorization session changed; start again");
    var active=w.db.queryForList("SELECT state_hash FROM github_oauth_attempts WHERE state_hash=? AND session_hash=? AND purpose=? AND account_id=? AND auth_version=? AND consumed_at IS NOT NULL AND expires_at>now() FOR UPDATE",
        stateHash,binding,purpose,uuid(actor),version);
    if(active.size()!=1)throw error(400,"GITHUB_STATE_INVALID","GitHub authorization was cancelled or expired; start again");
  }
  private void checkActor(HttpServletRequest request,String expected,Object version){
    if(!Objects.equals(expected,accounts.actor(request))||(expected!=null&&authVersion(expected)!=((Number)version).intValue()))throw error(409,"GITHUB_SESSION_CHANGED","Account session or credentials changed; start again");
  }
  void unlink(HttpServletRequest request){
    String actor=accounts.require(request);
    w.tx.executeWithoutResult(tx->{
      w.db.queryForObject("SELECT id FROM accounts WHERE id=? FOR UPDATE",UUID.class,uuid(actor));
      accounts.requirePasswordAccount(actor);
      w.db.update("DELETE FROM github_links WHERE account_id=?",uuid(actor));
      w.db.update("DELETE FROM github_oauth_attempts WHERE account_id=?",uuid(actor));
    });
  }
  static boolean validSignupUsername(String name){return name.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,38}");}
  Map<String,Object> signup(HttpServletRequest request){
    if(accounts.actor(request)!=null)throw error(409,"GITHUB_SESSION_CHANGED","Sign out before completing GitHub signup");
    String binding=correlation(request,false);
    var rows=w.db.queryForList("SELECT github_id,login,expires_at FROM github_signup_claims WHERE session_hash=? AND expires_at>now()",binding);
    if(rows.size()!=1)throw error(400,"GITHUB_SIGNUP_INVALID","GitHub signup expired or was already completed; start again");
    var row=rows.getFirst();String login=row.get("login").toString();
    return map("githubLogin",login,"suggestedUsername",login,"expiresAt",((Timestamp)row.get("expires_at")).toInstant().toString());
  }
  void completeSignup(HttpServletRequest request,String username){
    accounts.throttle("github-signup",request.getRemoteAddr(),30);
    String name=username.strip(),binding=correlation(request,false);
    if(!validSignupUsername(name))throw error(400,"INVALID_USERNAME","Username must contain 1..39 letters, digits, underscores or hyphens and start with a letter or digit");
    try{
      w.tx.executeWithoutResult(tx->{
        if(accounts.actor(request)!=null)throw error(409,"GITHUB_SESSION_CHANGED","Account session changed; start again");
        var rows=w.db.queryForList("SELECT github_id,login FROM github_signup_claims WHERE session_hash=? AND expires_at>now() FOR UPDATE",binding);
        if(rows.size()!=1)throw error(400,"GITHUB_SIGNUP_INVALID","GitHub signup expired or was already completed; start again");
        if(!binding.equals(correlation(request,false))||accounts.actor(request)!=null)throw error(409,"GITHUB_SESSION_CHANGED","Account session changed; start again");
        var row=rows.getFirst();String account=id();
        // Unique identity and username indexes settle races atomically. Never merge by email/name.
        w.db.update("INSERT INTO accounts(id,username,auth_method,display_name) VALUES(?,?,'github',?)",uuid(account),name,name);
        w.db.update("INSERT INTO github_links(account_id,github_id,login) VALUES(?,?,?)",uuid(account),row.get("github_id"),row.get("login"));
        w.db.update("DELETE FROM github_signup_claims WHERE session_hash=?",binding);
        accounts.signIn(request,account,1);
      });
    }catch(DuplicateKeyException failure){throw error(409,"ACCOUNT_CONFLICT","Username or GitHub identity is already registered; choose another username or restart GitHub login");}
  }
  Credential credential(HttpServletRequest request){
    return new GitHubRefresh(w,accounts,config,client).credential(request);
  }
}
