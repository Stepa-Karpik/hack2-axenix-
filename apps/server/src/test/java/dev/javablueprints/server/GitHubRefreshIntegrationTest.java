package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Real migrated PostgreSQL rows/locks; only fixed-provider transport is a fixture. */
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"jb.runner.enabled=false","jb.origins=http://localhost:5174","jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class GitHubRefreshIntegrationTest {
  static final String SCHEMA="jbrefresh_"+UUID.randomUUID().toString().replace("-","");
  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p){
    p.add("spring.flyway.default-schema",()->SCHEMA);p.add("spring.flyway.schemas",()->SCHEMA);p.add("spring.datasource.hikari.schema",()->SCHEMA);
  }
  @Autowired Workspace w;
  @Autowired Accounts accounts;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;
  @AfterAll void cleanup(){assertTrue(SCHEMA.matches("jbrefresh_[a-f0-9]{32}"));w.db.execute("DROP SCHEMA "+SCHEMA+" CASCADE");}

  final class Fixture implements AutoCloseable {
    final String account=id(),grant=id(),generation=id();
    final GitHubConfig config=GitHubClientTest.config();
    final GitHubCrypto crypto=new GitHubCrypto(config.key);
    final CountDownLatch entered=new CountDownLatch(1),release=new CountDownLatch(1);
    final ExecutorService pool=Executors.newFixedThreadPool(2);
    final AtomicInteger posts=new AtomicInteger();
    final GitHubClient provider;
    Fixture(){
      String username="refresh_"+account.replace("-","").substring(0,16);
      // Synthetic SQL seed: no registration, SMTP, provider login or project/source writes.
      w.db.update("INSERT INTO accounts(id,username,email,password_hash,display_name) VALUES(?,?,?,?,?)",uuid(account),username,username+"@example.invalid","not-a-login-password",username);
      w.db.update("INSERT INTO github_links(account_id,github_id,login) VALUES(?,?,?)",uuid(account),providerId(),"refresh-fixture");
      w.db.update("INSERT INTO github_credentials(account_id,token_ciphertext,granted_scopes,grant_version,expires_at,refresh_ciphertext,refresh_expires_at,token_version) VALUES(?,?,?,?::uuid,?,?,?,?::uuid)",
          uuid(account),crypto.seal("old-access","repository|"+account+"|"+providerId()),"repo",grant,Timestamp.from(Instant.now().minusSeconds(1)),crypto.seal("old-refresh","repository-refresh|"+account+"|"+providerId()),Timestamp.from(Instant.now().plusSeconds(10000)),generation);
      provider=new GitHubClient((method,uri,headers,body,limit)->{
        assertFalse(TransactionSynchronizationManager.isActualTransactionActive(),"Provider I/O must hold no DB transaction/row lock");
        if(method.equals("POST")){
          assertEquals("https://github.com/login/oauth/access_token",uri.toString());posts.incrementAndGet();entered.countDown();
          if(!release.await(10,TimeUnit.SECONDS))throw new AssertionError("Provider barrier not released");
          return GitHubClientTest.json(200,map("access_token","new-access","refresh_token","new-refresh","expires_in",28800,"refresh_token_expires_in",15897600,"scope","repo","token_type","bearer"));
        }
        assertEquals("https://api.github.com/user",uri.toString());return GitHubClientTest.json(200,map("id",providerId()));
      });
    }
    String providerId(){return new java.math.BigInteger(account.replace("-","").substring(0,14),16).add(java.math.BigInteger.ONE).toString();}
    MockHttpServletRequest request(){var r=new MockHttpServletRequest();r.getSession(true).setAttribute("accountId",account);r.getSession().setAttribute("authVersion",1);return r;}
    GitHubRefresh helper(){return new GitHubRefresh(w,accounts,config,provider);}
    Future<GitHubService.Credential> start(){return pool.submit(()->helper().credential(request()));}
    void awaitProvider()throws Exception{assertTrue(entered.await(5,TimeUnit.SECONDS),"Refresh did not reach provider");}
    Map<String,Object> row(){return w.db.queryForMap("SELECT token_ciphertext,refresh_ciphertext,grant_version::text,token_version::text,refresh_owner::text,refresh_reconnect FROM github_credentials WHERE account_id=?",uuid(account));}
    @Override public void close()throws Exception{release.countDown();pool.shutdownNow();assertTrue(pool.awaitTermination(5,TimeUnit.SECONDS));}
  }
  ApiError failed(Future<?> result)throws Exception{return assertInstanceOf(ApiError.class,assertThrows(ExecutionException.class,()->result.get(5,TimeUnit.SECONDS)).getCause());}

  @Test void actualPostgresClaimAllowsOneProviderPostAcrossTwoHelpersAndPreservesLogicalGrant()throws Exception{
    try(var f=new Fixture()){
      var first=f.start();f.awaitProvider();var claimed=f.row();assertInstanceOf(String.class,claimed.get("refresh_owner"));assertNotNull(claimed.get("refresh_owner"));
      // A separate helper and connection must complete promptly while first provider call is paused.
      var second=f.pool.submit(()->f.helper().credential(f.request()));assertEquals("GITHUB_REFRESH_PENDING",failed(second).code);assertEquals(1,f.posts.get());
      f.release.countDown();var rotated=first.get(5,TimeUnit.SECONDS);assertEquals("new-access",rotated.token());assertEquals(f.grant,rotated.version());
      var stored=f.row();assertEquals(f.grant,stored.get("grant_version"));assertNotEquals(f.generation,stored.get("token_version"));assertNull(stored.get("refresh_owner"));assertEquals(false,stored.get("refresh_reconnect"));
      assertEquals("new-refresh",f.crypto.open(stored.get("refresh_ciphertext").toString(),"repository-refresh|"+f.account+"|"+f.providerId()));
      assertEquals("new-access",f.helper().credential(f.request()).token());assertEquals(1,f.posts.get());
    }
  }
  @Test void realUnlinkCommitsWhileProviderPausedAndRefreshCannotRestoreCredential()throws Exception{
    try(var f=new Fixture()){
      var result=f.start();f.awaitProvider();
      new GitHubService(w,accounts,f.config,f.provider).unlink(f.request());
      assertEquals(0,w.db.queryForObject("SELECT count(*) FROM github_credentials WHERE account_id=?",Integer.class,uuid(f.account)));
      f.release.countDown();assertEquals("GITHUB_RECONNECT",failed(result).code);
      assertEquals(0,w.db.queryForObject("SELECT count(*) FROM github_links WHERE account_id=?",Integer.class,uuid(f.account)));assertEquals(0,w.db.queryForObject("SELECT count(*) FROM github_credentials WHERE account_id=?",Integer.class,uuid(f.account)));
    }
  }
  @Test void actualAuthVersionChangeDuringProviderCallWinsOverRefreshResult()throws Exception{
    try(var f=new Fixture()){
      var result=f.start();f.awaitProvider();
      w.tx.executeWithoutResult(tx->{w.db.queryForObject("SELECT id FROM accounts WHERE id=? FOR UPDATE",UUID.class,uuid(f.account));w.db.update("UPDATE accounts SET auth_version=auth_version+1 WHERE id=?",uuid(f.account));});
      f.release.countDown();assertEquals("GITHUB_SESSION_CHANGED",failed(result).code);assertEquals(f.generation,f.row().get("token_version"));assertEquals(true,f.row().get("refresh_reconnect"));
    }
  }
  @Test void newGrantDuringProviderCallWinsAndStaleCleanupDoesNotInvalidateIt()throws Exception{
    try(var f=new Fixture()){
      var result=f.start();f.awaitProvider();String newGrant=id(),newToken=id();
      w.tx.executeWithoutResult(tx->{w.db.queryForObject("SELECT id FROM accounts WHERE id=? FOR UPDATE",UUID.class,uuid(f.account));w.db.update("UPDATE github_credentials SET grant_version=?::uuid,token_version=?::uuid,token_ciphertext=?,refresh_owner=NULL,refresh_lease_until=NULL,refresh_reconnect=false WHERE account_id=?",newGrant,newToken,f.crypto.seal("consent-access","repository|"+f.account+"|"+f.providerId()),uuid(f.account));});
      f.release.countDown();assertEquals("GITHUB_RECONNECT",failed(result).code);var stored=f.row();assertEquals(newGrant,stored.get("grant_version"));assertEquals(newToken,stored.get("token_version"));assertEquals(false,stored.get("refresh_reconnect"));
      assertEquals("consent-access",f.crypto.open(stored.get("token_ciphertext").toString(),"repository|"+f.account+"|"+f.providerId()));
    }
  }
  @Test void v7ConstraintsRejectPartialRefreshPairAndPartialClaim()throws Exception{
    try(var f=new Fixture()){
      assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->w.db.update("UPDATE github_credentials SET refresh_ciphertext=NULL WHERE account_id=?",uuid(f.account)));
      assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->w.db.update("UPDATE github_credentials SET refresh_owner=?::uuid WHERE account_id=?",id(),uuid(f.account)));
      assertEquals(f.generation,f.row().get("token_version"));
    }
  }
}
