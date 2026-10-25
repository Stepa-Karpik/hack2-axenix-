package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.*;

class GitHubRefreshTest {
  static final class Fixture {
    final JdbcTemplate db=mock(JdbcTemplate.class); final Accounts accounts=mock(Accounts.class);
    final PlatformTransactionManager manager=mock(PlatformTransactionManager.class);
    final Workspace workspace=new Workspace(db,manager);final GitHubConfig config=GitHubClientTest.config();
    final MockHttpServletRequest request=new MockHttpServletRequest(); final String account=id(),grant=id(),generation=id();
    final AtomicReference<Map<String,Object>> row=new AtomicReference<>(); final AtomicInteger version=new AtomicInteger(3),posts=new AtomicInteger();
    final AtomicBoolean inTransaction=new AtomicBoolean(); Runnable providerBarrier=()->{};
    Map<String,Object> response=map("access_token","new-access","refresh_token","new-refresh","expires_in",28800,"refresh_token_expires_in",15897600,"scope","repo","token_type","bearer");
    String identity="111";boolean networkFailure,storeFailure;
    final GitHubClient client;
    final GitHubRefresh service;
    Fixture(){
      request.getSession(true); when(accounts.actor(request)).thenReturn(account);when(accounts.require(request)).thenReturn(account);
      when(manager.getTransaction(any())).thenAnswer(call->{assertFalse(inTransaction.getAndSet(true));return mock(TransactionStatus.class);});
      doAnswer(call->{inTransaction.set(false);return null;}).when(manager).commit(any());
      doAnswer(call->{inTransaction.set(false);return null;}).when(manager).rollback(any());
      when(db.queryForObject(anyString(),eq(Integer.class),eq(uuid(account)))).thenAnswer(call->version.get());
      when(db.queryForList(eq(GitHubRefresh.ROW),eq(uuid(account)))).thenAnswer(call->row.get()==null?List.of():List.of(new HashMap<>(row.get())));
      when(db.update(anyString(),any(Object[].class))).thenAnswer(call->{
        String sql=call.getArgument(0);Object[] args=call.getArguments();var current=row.get();if(current==null)return 0;
        if(sql.startsWith("UPDATE github_credentials SET refresh_owner=")){
          if(current.get("refresh_owner")!=null||!current.get("grant_version").equals(args[3])||!current.get("token_version").equals(args[4]))return 0;
          current.put("refresh_owner",args[1]);current.put("refresh_lease_until",Timestamp.from(Instant.now().plusSeconds(60)));return 1;
        }
        if(sql.startsWith("UPDATE github_credentials SET token_ciphertext=")){
          if(storeFailure)throw new org.springframework.dao.DataAccessResourceFailureException("database unavailable");
          if(!current.get("grant_version").equals(args[7])||!current.get("token_version").equals(args[8])||!Objects.equals(current.get("refresh_owner"),args[9]))return 0;
          current.put("token_ciphertext",args[1]);current.put("refresh_ciphertext",args[2]);current.put("expires_at",args[3]);current.put("refresh_expires_at",args[4]);current.put("token_version",args[5]);current.put("refresh_owner",null);current.put("refresh_lease_until",null);return 1;
        }
        if(sql.startsWith("UPDATE github_credentials SET refresh_reconnect=true")){
          boolean exact=sql.contains("grant_version")?current.get("grant_version").equals(args[2])&&current.get("token_version").equals(args[3])&&Objects.equals(current.get("refresh_owner"),args[4]):current.get("token_version").equals(args[2]);
          if(!exact)return 0;current.put("refresh_reconnect",true);current.put("refresh_owner",null);current.put("refresh_lease_until",null);return 1;
        }
        throw new AssertionError("Unexpected SQL mutation");
      });
      var crypto=new GitHubCrypto(config.key);
      row.set(new HashMap<>(map("github_id","111","grant_version",grant,"token_version",generation,"granted_scopes","repo","expires_at",Timestamp.from(Instant.now().minusSeconds(1)),"refresh_expires_at",Timestamp.from(Instant.now().plusSeconds(10000)),"refresh_reconnect",false,"token_ciphertext",crypto.seal("old-access","repository|"+account+"|111"),"refresh_ciphertext",crypto.seal("old-refresh","repository-refresh|"+account+"|111"))));
      client=new GitHubClient((method,uri,headers,body,limit)->{
        assertFalse(inTransaction.get(),"Provider network must run outside DB transaction");
        if(method.equals("POST")){posts.incrementAndGet();assertEquals("https://github.com/login/oauth/access_token",uri.toString());assertNull(uri.getQuery());String form=new String(body,java.nio.charset.StandardCharsets.UTF_8);assertTrue(form.contains("grant_type=refresh_token"));assertTrue(form.contains("refresh_token=old-refresh"));assertTrue(form.contains("client_secret=secret-fixture"));assertFalse(form.contains("scope="));providerBarrier.run();if(networkFailure)throw new java.io.IOException("sensitive-provider-body");return GitHubClientTest.json(200,response);}
        assertEquals("/user",uri.getPath());return GitHubClientTest.json(200,map("id",identity));
      });service=new GitHubRefresh(workspace,accounts,config,client);
    }
  }
  @Test void rotatesEncryptedPairWithoutChangingLogicalGrantAndWithoutHoldingNetworkLock(){
    var f=new Fixture();var value=f.service.credential(f.request);assertEquals("new-access",value.token());assertEquals(f.grant,value.version());
    assertEquals(f.grant,f.row.get().get("grant_version"));assertNotEquals(f.generation,f.row.get().get("token_version"));
    var crypto=new GitHubCrypto(f.config.key);String access=f.row.get().get("token_ciphertext").toString(),refresh=f.row.get().get("refresh_ciphertext").toString();
    assertFalse(access.contains("new-access"));assertFalse(refresh.contains("new-refresh"));
    assertEquals("new-refresh",crypto.open(refresh,"repository-refresh|"+f.account+"|111"));assertThrows(ApiError.class,()->crypto.open(refresh,"repository|"+f.account+"|111"));
    assertEquals("new-access",f.service.credential(f.request).token());assertEquals(1,f.posts.get());
  }
  @Test void secondServiceInstanceCannotConsumeTheSameSingleUseRefresh(){
    var f=new Fixture();var second=new GitHubRefresh(f.workspace,f.accounts,f.config,f.client);
    f.providerBarrier=()->assertEquals("GITHUB_REFRESH_PENDING",assertThrows(ApiError.class,()->second.credential(f.request)).code);
    assertEquals("new-access",f.service.credential(f.request).token());assertEquals(1,f.posts.get());
  }
  @Test void unlinkDuringNetworkCannotRecreateCredential(){
    var f=new Fixture();f.providerBarrier=()->f.row.set(null);
    assertEquals("GITHUB_RECONNECT",assertThrows(ApiError.class,()->f.service.credential(f.request)).code);assertNull(f.row.get());
  }
  @Test void newConsentDuringNetworkWinsAndOldFailureCannotClearNewGrant(){
    var f=new Fixture();String replacement=id();f.providerBarrier=()->{f.row.get().put("grant_version",replacement);f.row.get().put("token_version",id());f.row.get().put("refresh_owner",null);};
    assertThrows(ApiError.class,()->f.service.credential(f.request));assertEquals(replacement,f.row.get().get("grant_version"));assertEquals(false,f.row.get().get("refresh_reconnect"));
  }
  @Test void passwordOrSessionChangeDuringExchangePreventsPersistingNewPair(){
    for(boolean password:List.of(true,false)){
      var f=new Fixture();f.providerBarrier=()->{if(password)f.version.incrementAndGet();else f.request.changeSessionId();};
      assertEquals("GITHUB_SESSION_CHANGED",assertThrows(ApiError.class,()->f.service.credential(f.request)).code);assertEquals(f.generation,f.row.get().get("token_version"));assertEquals(true,f.row.get().get("refresh_reconnect"));
    }
  }
  @Test void uncertainNetworkFailureRequiresReconnectWithoutReplayingConsumedRefresh(){
    var f=new Fixture();f.networkFailure=true;var failure=assertThrows(ApiError.class,()->f.service.credential(f.request));assertFalse(failure.getMessage().contains("sensitive-provider-body"));
    assertEquals(true,f.row.get().get("refresh_reconnect"));assertEquals("GITHUB_RECONNECT",assertThrows(ApiError.class,()->f.service.credential(f.request)).code);assertEquals(1,f.posts.get());
  }
  @Test void providerSuccessThenDatabaseFailureRequiresReconnectWithoutOldTokenReuse(){
    var f=new Fixture();f.storeFailure=true;assertEquals("GITHUB_RECONNECT",assertThrows(ApiError.class,()->f.service.credential(f.request)).code);
    assertEquals(true,f.row.get().get("refresh_reconnect"));assertEquals(f.generation,f.row.get().get("token_version"));
    assertThrows(ApiError.class,()->f.service.credential(f.request));assertEquals(1,f.posts.get());
  }
  @Test void abandonedExpiredClaimIsNotAutomaticallyReplayed(){
    var f=new Fixture();f.row.get().put("refresh_owner",id());f.row.get().put("refresh_lease_until",Timestamp.from(Instant.now().minusSeconds(1)));
    assertEquals("GITHUB_RECONNECT",assertThrows(ApiError.class,()->f.service.credential(f.request)).code);assertEquals(true,f.row.get().get("refresh_reconnect"));assertEquals(0,f.posts.get());
  }
  @Test void expiredRefreshNeedsReconnectButLegacyNonexpiringCredentialStillWorks(){
    var f=new Fixture();f.row.get().put("refresh_expires_at",Timestamp.from(Instant.now().minusSeconds(1)));assertThrows(ApiError.class,()->f.service.credential(f.request));assertEquals(0,f.posts.get());
    f.row.get().put("expires_at",null);f.row.get().put("refresh_ciphertext",null);f.row.get().put("refresh_expires_at",null);assertEquals("old-access",f.service.credential(f.request).token());assertEquals(0,f.posts.get());
  }
  @Test void badRefreshMalformedPairOrChangedIdentityOrScopesNeverPersistsTokens(){
    for(String failure:List.of("bad","pair","identity","scope")){
      var f=new Fixture();switch(failure){case "bad"->f.response=map("error","bad_refresh_token","error_description","secret-response");case "pair"->f.response.remove("refresh_token");case "identity"->f.identity="222";case "scope"->f.response.put("scope","repo,gist");}
      assertThrows(ApiError.class,()->f.service.credential(f.request),failure);assertEquals(f.generation,f.row.get().get("token_version"));assertEquals(true,f.row.get().get("refresh_reconnect"));
    }
  }
  @Test void exactIntegralJsonExponentExpiryWorksWithoutAcceptingFractionalOrNonfiniteValues(){
    var client=new GitHubClient((m,u,h,b,l)->new GitHubClient.Reply(200,Map.of(),"{\"access_token\":\"access\",\"refresh_token\":\"refresh\",\"expires_in\":2.88E+4,\"refresh_token_expires_in\":1.58976E+7,\"scope\":\"repo\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    var pair=GitHubClient.tokenPair(client.refresh(GitHubClientTest.config(),"old-refresh"),true);
    assertTrue(pair.expires().isAfter(Instant.now().plusSeconds(28790)));
    for(Object expiry:List.of(Double.NaN,Double.POSITIVE_INFINITY,Double.NEGATIVE_INFINITY,0.1,new java.math.BigDecimal("1.01")))assertThrows(ApiError.class,()->GitHubClient.tokenPair(map("access_token","a","refresh_token","r","expires_in",expiry,"refresh_token_expires_in",1000),true));
  }
  @Test void tokenPairRejectsPartialFractionalUnboundedAndWrongTypeResponses(){
    for(Object expiry:List.of(0,-1,1.5,Long.MAX_VALUE,"28800"))assertThrows(ApiError.class,()->GitHubClient.tokenPair(map("access_token","a","refresh_token","r","expires_in",expiry,"refresh_token_expires_in",1000),true));
    assertThrows(ApiError.class,()->GitHubClient.tokenPair(map("access_token","a","token_type","mac"),false));
    assertThrows(ApiError.class,()->GitHubClient.tokenPair(map("access_token","a","expires_in",1000),false));
    assertNull(GitHubClient.tokenPair(map("access_token","persistent","scope","repo"),false).refresh());
  }
}
