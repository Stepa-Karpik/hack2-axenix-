package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Real migrated PostgreSQL transactions; fixed provider transport, no real OAuth or SMTP. */
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"jb.runner.enabled=false","jb.origins=http://localhost:5174","jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class GitHubLinkIntegrationTest {
  static final String SCHEMA="jblink_"+UUID.randomUUID().toString().replace("-","");
  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p){
    p.add("spring.flyway.default-schema",()->SCHEMA);p.add("spring.flyway.schemas",()->SCHEMA);p.add("spring.datasource.hikari.schema",()->SCHEMA);
  }
  @Autowired Workspace w;
  @Autowired Accounts accounts;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;
  @AfterAll void cleanup(){assertTrue(SCHEMA.matches("jblink_[a-f0-9]{32}"));w.db.execute("DROP SCHEMA "+SCHEMA+" CASCADE");}

  final class Fixture {
    final String account=id(),githubId=new java.math.BigInteger(account.replace("-","").substring(0,14),16).add(java.math.BigInteger.ONE).toString();
    final GitHubConfig config=GitHubClientTest.config();
    final MockHttpServletRequest request=new MockHttpServletRequest();
    String scope="repo",access="link-access-fixture",refresh="link-refresh-fixture";
    Runnable duringExchange=()->{};
    final GitHubClient provider=new GitHubClient((method,uri,headers,body,limit)->{
      assertFalse(TransactionSynchronizationManager.isActualTransactionActive());
      if(method.equals("POST")){
        duringExchange.run();
        return GitHubClientTest.json(200,map("access_token",access,"refresh_token",refresh,"expires_in",28800,"refresh_token_expires_in",15897600,"scope",scope,"token_type","bearer"));
      }
      return GitHubClientTest.json(200,map("id",githubId,"login","link-fixture"));
    });
    final GitHubService service=new GitHubService(w,accounts,config,provider);
    Fixture(){
      String name="link_"+account.replace("-","").substring(0,20);
      w.db.update("INSERT INTO accounts(id,username,email,password_hash,display_name) VALUES(?,?,?,?,?)",uuid(account),name,name+"@example.invalid","not-a-login-password",name);
      request.getSession(true).setAttribute("accountId",account);request.getSession().setAttribute("authVersion",1);
    }
    Map<String,String> start(String purpose){
      var uri=java.net.URI.create(service.start(request,purpose).get("authorizationUrl").toString());
      var query=new HashMap<String,String>();for(String item:uri.getRawQuery().split("&")){var pair=item.split("=",2);query.put(pair[0],java.net.URLDecoder.decode(pair.length==2?pair[1]:"",java.nio.charset.StandardCharsets.UTF_8));}return query;
    }
    String callback(String purpose){return service.callback(request,start(purpose).get("state"),"code-fixture",null);}
    int count(String table){return w.db.queryForObject("SELECT count(*) FROM "+table+" WHERE account_id=?",Integer.class,uuid(account));}
  }

  @Test void connectingRequestsRepositoryScopeAndStoresEncryptedRefreshableGrantAtomically(){
    var f=new Fixture();var query=f.start("link");assertEquals("repo",query.get("scope"));assertEquals("S256",query.get("code_challenge_method"));
    assertEquals("/settings/integrations?github=link_success",f.service.callback(f.request,query.get("state"),"code-fixture",null));
    assertEquals(1,f.count("github_links"));assertEquals(true,f.service.status(f.request).get("repositoryAccess"));
    var stored=w.db.queryForMap("SELECT * FROM github_credentials WHERE account_id=?",uuid(f.account));var crypto=new GitHubCrypto(f.config.key);
    assertNotEquals(f.access,stored.get("token_ciphertext"));assertNotEquals(f.refresh,stored.get("refresh_ciphertext"));
    assertEquals(f.access,crypto.open(stored.get("token_ciphertext").toString(),"repository|"+f.account+"|"+f.githubId));
    assertEquals(f.refresh,crypto.open(stored.get("refresh_ciphertext").toString(),"repository-refresh|"+f.account+"|"+f.githubId));
    assertNotNull(stored.get("expires_at"));assertNotNull(stored.get("refresh_expires_at"));assertNotNull(stored.get("grant_version"));
    org.mockito.Mockito.verifyNoInteractions(mail);
  }

  @Test void missingRepositoryScopeLeavesNoLinkOrGrantAndAttemptCannotReplay(){
    var f=new Fixture();f.scope="read:user";var query=f.start("link");String state=query.get("state");
    assertEquals("GITHUB_SCOPE_REQUIRED",assertThrows(ApiError.class,()->f.service.callback(f.request,state,"code-fixture",null)).code);
    assertEquals(0,f.count("github_links"));assertEquals(0,f.count("github_credentials"));
    assertEquals("GITHUB_STATE_INVALID",assertThrows(ApiError.class,()->f.service.callback(f.request,state,"code-fixture",null)).code);
  }

  @Test void storageFailureRollsBackIdentityLinkAsWellAsCredential(){
    var f=new Fixture();
    // An isolated schema constraint injects a real failure after link insertion, at grant persistence.
    w.db.execute("ALTER TABLE github_credentials ADD CONSTRAINT link_fixture_failure CHECK(account_id <> '"+uuid(f.account)+"'::uuid)");
    try {
      assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->f.callback("link"));
      assertEquals(0,f.count("github_links"));assertEquals(0,f.count("github_credentials"));
    } finally {w.db.execute("ALTER TABLE github_credentials DROP CONSTRAINT link_fixture_failure");}
  }

  @Test void legacyIdentityOnlyLinkCanAcquireAndRenewGrantViaRepositoriesPurpose(){
    var f=new Fixture();w.db.update("INSERT INTO github_links(account_id,github_id,login) VALUES(?,?,?)",uuid(f.account),f.githubId,"link-fixture");
    assertEquals(false,f.service.status(f.request).get("repositoryAccess"));
    assertEquals("/settings/integrations?github=repositories_success",f.callback("repositories"));
    Object original=w.db.queryForObject("SELECT grant_version FROM github_credentials WHERE account_id=?",UUID.class,uuid(f.account));
    f.access="renewed-link-access";f.refresh="renewed-link-refresh";
    assertEquals("/settings/integrations?github=repositories_success",f.callback("repositories"));
    assertNotEquals(original,w.db.queryForObject("SELECT grant_version FROM github_credentials WHERE account_id=?",UUID.class,uuid(f.account)));
    assertEquals(1,f.count("github_links"));assertEquals(1,f.count("github_credentials"));
  }

  @Test void unlinkAndAuthVersionChangeDuringProviderExchangePreventLinkAndGrant(){
    for(boolean unlink:List.of(true,false)){
      var f=new Fixture();f.duringExchange=()->{if(unlink)f.service.unlink(f.request);else w.db.update("UPDATE accounts SET auth_version=auth_version+1 WHERE id=?",uuid(f.account));};
      assertEquals(unlink?"GITHUB_STATE_INVALID":"GITHUB_SESSION_CHANGED",assertThrows(ApiError.class,()->f.callback("link")).code);
      assertEquals(0,f.count("github_links"));assertEquals(0,f.count("github_credentials"));
    }
  }

  @Test void identityMismatchAndMissingScopePreserveExistingLinkAndGrant(){
    var f=new Fixture();f.callback("link");Object generation=w.db.queryForObject("SELECT grant_version FROM github_credentials WHERE account_id=?",UUID.class,uuid(f.account));
    f.scope="";assertEquals("GITHUB_SCOPE_REQUIRED",assertThrows(ApiError.class,()->f.callback("link")).code);
    assertEquals(generation,w.db.queryForObject("SELECT grant_version FROM github_credentials WHERE account_id=?",UUID.class,uuid(f.account)));
    w.db.update("UPDATE github_links SET github_id=? WHERE account_id=?","9999999999999999999",uuid(f.account));f.scope="repo";
    assertEquals("GITHUB_ACCOUNT_MISMATCH",assertThrows(ApiError.class,()->f.callback("link")).code);
    assertEquals(generation,w.db.queryForObject("SELECT grant_version FROM github_credentials WHERE account_id=?",UUID.class,uuid(f.account)));
  }
}
