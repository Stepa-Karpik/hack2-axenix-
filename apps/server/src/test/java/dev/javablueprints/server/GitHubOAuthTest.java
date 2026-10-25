package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static dev.javablueprints.server.Workspace.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.PlatformTransactionManager;

class GitHubOAuthTest {
  final JdbcTemplate db=mock(JdbcTemplate.class);
  final Workspace workspace=new Workspace(db,mock(PlatformTransactionManager.class));
  final Accounts accounts=mock(Accounts.class);
  final MockHttpServletRequest request=new MockHttpServletRequest();
  final GitHubConfig config=GitHubClientTest.config();
  final List<String> outgoing=new ArrayList<>();
  final GitHubClient client=new GitHubClient((method,uri,headers,body,limit)->{
    outgoing.add(uri.getHost()+uri.getPath());
    if(method.equals("POST"))return GitHubClientTest.json(200,map("access_token","identity-token-fixture","scope",""));
    return GitHubClientTest.json(200,map("id",111,"login","same-name","email","same@example.com"));
  });
  final GitHubService service=new GitHubService(workspace,accounts,config,client);
  final String state=AccountPasswords.token();
  GitHubOAuthTest(){request.getSession(true).setAttribute("githubCorrelation","session-correlation");when(accounts.actor(request)).thenReturn(null);}
  Map<String,Object> attempt(){return map("purpose","login","account_id",null,"auth_version",null,"verifier_ciphertext",new GitHubCrypto(config.key).seal("verifier-fixture","pkce|"+hash(state)));}
  void consumeOnce(){
    var used=new AtomicBoolean();
    when(db.queryForList(startsWith("UPDATE github_oauth_attempts"),eq(hash(state)),eq(hash("session-correlation"))))
      .thenAnswer(call->used.getAndSet(true)?List.of():List.of(attempt()));
  }
  @Test void startUsesS256AndStoresOnlyEncryptedVerifierWithSessionPurposeBinding() throws Exception {
    when(db.queryForObject("SELECT count(*) FROM github_oauth_attempts",Integer.class)).thenReturn(0);
    var result=service.start(request,"login");var uri=java.net.URI.create(result.get("authorizationUrl").toString());
    assertEquals("https",uri.getScheme());assertEquals("github.com",uri.getHost());
    var query=new java.util.HashMap<String,String>();
    for(String item:uri.getRawQuery().split("&")){var pair=item.split("=",2);query.put(pair[0],java.net.URLDecoder.decode(pair.length==2?pair[1]:"",java.nio.charset.StandardCharsets.UTF_8));}
    assertEquals("S256",query.get("code_challenge_method"));assertEquals("",query.get("scope"));assertEquals("false",query.get("allow_signup"));
    var encrypted=org.mockito.ArgumentCaptor.forClass(String.class);
    verify(db).update(startsWith("INSERT INTO github_oauth_attempts"),eq(hash(query.get("state"))),eq(hash("session-correlation")),eq("login"),isNull(),isNull(),encrypted.capture());
    String verifier=new GitHubCrypto(config.key).open(encrypted.getValue(),"pkce|"+hash(query.get("state")));
    String challenge=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(java.nio.charset.StandardCharsets.US_ASCII)));
    assertEquals(challenge,query.get("code_challenge"));assertFalse(encrypted.getValue().contains(verifier));assertTrue(outgoing.isEmpty());
  }
  @Test void linkedStableIdentityUsesExistingRotatingAccountSessionSeam() {
    consumeOnce();String account=id();
    when(db.queryForList(eq("SELECT account_id::text FROM github_links WHERE github_id=?"),eq("111"))).thenReturn(List.of(map("account_id",account)));
    when(db.queryForObject(eq("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE"),eq(Integer.class),eq(uuid(account)))).thenReturn(7);
    when(db.queryForList(eq("SELECT github_id FROM github_links WHERE account_id=? FOR UPDATE"),eq(uuid(account)))).thenReturn(List.of(map("github_id","111")));
    assertEquals("/projects?github=login_success",service.callback(request,state,"code",null));
    verify(accounts).signIn(request,account,7);
  }
  @Test void missingMismatchedOrReplayedStateNeverExchangesAnotherCode(){
    assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->service.callback(request,null,"code",null)).code);
    when(db.queryForList(startsWith("UPDATE github_oauth_attempts"),anyString(),anyString())).thenReturn(List.of());
    assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->service.callback(request,state,"code",null)).code);
    assertTrue(outgoing.isEmpty());
  }
  @Test void unlinkedIdentityStoresPendingSignupWithoutEmailMergeAndStateIsOneUse(){
    consumeOnce();when(db.queryForList(eq("SELECT account_id::text FROM github_links WHERE github_id=?"),eq("111"))).thenReturn(List.of());
    when(db.queryForList(startsWith("SELECT state_hash FROM github_oauth_attempts"),anyString(),anyString())).thenReturn(List.of(map("state_hash",hash(state))));
    when(db.queryForList(startsWith("SELECT github_id,login FROM github_signup_claims"),anyString())).thenReturn(List.of(map("github_id","111","login","same-name")));
    when(db.update(startsWith("INSERT INTO accounts"),any(Object.class),any(Object.class),any(Object.class))).thenThrow(new org.springframework.dao.DuplicateKeyException("occupied"));
    assertEquals("/github/complete",service.callback(request,state,"code",null));
    assertEquals(2,outgoing.size());
    assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->service.callback(request,state,"another-code",null)).code);
    assertEquals(2,outgoing.size());verify(accounts,never()).signIn(any(),anyString(),anyInt());
    verify(db,never()).queryForList(contains("email"),any(Object.class));
  }
  @Test void denialConsumesAttemptWithoutExchangingToken(){
    consumeOnce();assertEquals("GITHUB_AUTH_DENIED",assertThrows(ApiError.class,()->service.callback(request,state,null,"access_denied")).code);
    assertTrue(outgoing.isEmpty());assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->service.callback(request,state,"code",null)).code);
  }
  @Test void changingLocalActorBeforeCallbackIsRefusedBeforeNetwork(){
    consumeOnce();when(accounts.actor(request)).thenReturn(id());
    assertEquals("GITHUB_SESSION_CHANGED",assertThrows(ApiError.class,()->service.callback(request,state,"code",null)).code);assertTrue(outgoing.isEmpty());
  }
  @Test void anotherBrowserSessionCannotConsumeTheAttempt(){
    request.getSession().setAttribute("githubCorrelation","other-browser");
    when(db.queryForList(startsWith("UPDATE github_oauth_attempts"),eq(hash(state)),eq(hash("other-browser")))).thenReturn(List.of());
    assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->service.callback(request,state,"code",null)).code);assertTrue(outgoing.isEmpty());
  }
}
