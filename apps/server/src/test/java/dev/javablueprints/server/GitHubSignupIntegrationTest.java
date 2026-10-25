package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpServletRequest;

/** Migrated, isolated PostgreSQL schema; synthetic provider only, no SMTP or project writes. */
@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties={"jb.runner.enabled=false","jb.origins=http://localhost:5174","jb.smtp.host="})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class GitHubSignupIntegrationTest {
  static final String SCHEMA="jbsignup_"+UUID.randomUUID().toString().replace("-","");
  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p){
    p.add("spring.flyway.default-schema",()->SCHEMA);p.add("spring.flyway.schemas",()->SCHEMA);p.add("spring.datasource.hikari.schema",()->SCHEMA);
  }
  @Autowired Workspace w;
  @Autowired Accounts accounts;
  @org.springframework.test.context.bean.override.mockito.MockitoBean AccountMail mail;
  @org.springframework.test.context.bean.override.mockito.MockitoBean JobWorker worker;
  @AfterAll void cleanup(){assertTrue(SCHEMA.matches("jbsignup_[a-f0-9]{32}"));w.db.execute("DROP SCHEMA "+SCHEMA+" CASCADE");}
  final class Fixture {
    final String githubId=new java.math.BigInteger(UUID.randomUUID().toString().replace("-","").substring(0,14),16).add(java.math.BigInteger.ONE).toString();
    final String name="gh-"+githubId;
    final GitHubConfig config=GitHubClientTest.config();
    final MockHttpServletRequest request=new MockHttpServletRequest();
    final GitHubClient client=new GitHubClient((method,uri,headers,body,limit)->method.equals("POST")
      ?GitHubClientTest.json(200,map("access_token","signup-fixture-token","scope",""))
      :GitHubClientTest.json(200,map("id",githubId,"login",name,"email","occupied@example.invalid")));
    final GitHubService service=new GitHubService(w,accounts,config,client);
    Fixture(){request.getSession(true).setAttribute("githubCorrelation",AccountPasswords.token());}
    String binding(){return service.sessionBinding(request);}
    void pending(){w.db.update("INSERT INTO github_signup_claims(session_hash,github_id,login,expires_at) VALUES(?,?,?,now()+interval '10 minutes')",binding(),githubId,name);}
    String callback(){String state=AccountPasswords.token();w.db.update("INSERT INTO github_oauth_attempts(state_hash,session_hash,purpose,verifier_ciphertext,expires_at) VALUES(?,?,'login',?,now()+interval '10 minutes')",hash(state),binding(),new GitHubCrypto(config.key).seal("verifier","pkce|"+hash(state)));return service.callback(request,state,"code",null);}
  }
  String passwordAccount(String name){String account=id();w.db.update("INSERT INTO accounts(id,username,email,password_hash,display_name) VALUES(?,?,?,?,?)",uuid(account),name,name+"@example.invalid",AccountPasswords.encode("a-good-fixture-password"),name);return account;}
  @Test void callbackCreatesHyphenatedIdentityOnlyAccountAndRotatesSession(){
    var f=new Fixture();String old=f.request.getSession().getId();assertEquals("/projects?github=signup_success",f.callback());
    String account=accounts.require(f.request);var row=w.db.queryForMap("SELECT * FROM accounts WHERE id=?",uuid(account));
    assertEquals(f.name,row.get("username"));assertEquals("github",row.get("auth_method"));assertNull(row.get("email"));assertNull(row.get("password_hash"));assertEquals(false,row.get("email_verified"));assertNotEquals(old,f.request.getSession().getId());assertEquals("github",accounts.user(account,true).get("authMethod"));
    assertEquals(0,w.db.queryForObject("SELECT count(*) FROM github_credentials WHERE account_id=?",Integer.class,uuid(account)));
    assertEquals("INVALID_CREDENTIALS",assertThrows(ApiError.class,()->accounts.login(map("identifier",f.name,"password","a-good-fixture-password"),new MockHttpServletRequest())).code);
    assertEquals("GITHUB_ONLY_ACCOUNT",assertThrows(ApiError.class,()->accounts.changePassword(map("currentPassword","anything","newPassword","a-good-new-password"),f.request)).code);
    assertEquals("GITHUB_ONLY_ACCOUNT",assertThrows(ApiError.class,()->accounts.issue(account,"reset")).code);
    assertEquals("GITHUB_ONLY_ACCOUNT",assertThrows(ApiError.class,()->f.service.unlink(f.request)).code);
    String token=AccountPasswords.token();w.db.update("INSERT INTO account_tokens(token_hash,account_id,kind,expires_at) VALUES(?,?,'reset',now()+interval '1 hour')",hash(token),uuid(account));
    assertEquals("GITHUB_ONLY_ACCOUNT",assertThrows(ApiError.class,()->accounts.consume(token,"reset","a-good-new-password",f.request)).code);
    verifyNoInteractions(mail);
    f.request.getSession().invalidate();f.request.getSession(true).setAttribute("githubCorrelation",AccountPasswords.token());
    assertEquals("/projects?github=login_success",f.callback());assertEquals(account,accounts.require(f.request));
  }
  @Test void occupiedUsernameRequiresCompletionWithoutMergingAndClaimIsOneUse(){
    var f=new Fixture();String existing=passwordAccount(f.name);assertEquals("/github/complete",f.callback());assertNull(accounts.actor(f.request));assertEquals(f.name,f.service.signup(f.request).get("githubLogin"));
    assertEquals("ACCOUNT_CONFLICT",assertThrows(ApiError.class,()->f.service.completeSignup(f.request,f.name.toUpperCase(Locale.ROOT))).code);
    assertEquals("INVALID_USERNAME",assertThrows(ApiError.class,()->f.service.completeSignup(f.request,"bad/name")).code);
    var stranger=new MockHttpServletRequest();stranger.getSession(true).setAttribute("githubCorrelation",AccountPasswords.token());assertEquals("GITHUB_SIGNUP_INVALID",assertThrows(ApiError.class,()->f.service.completeSignup(stranger,"different-name")).code);
    f.service.completeSignup(f.request,"chosen-"+f.githubId);String account=accounts.require(f.request);assertNotEquals(existing,account);
    var replay=new MockHttpServletRequest();replay.setSession(f.request.getSession());replay.getSession().removeAttribute("accountId");replay.getSession().removeAttribute("authVersion");
    assertEquals("GITHUB_SIGNUP_INVALID",assertThrows(ApiError.class,()->f.service.completeSignup(replay,"replayed-name")).code);
    assertEquals("password",accounts.user(existing,true).get("authMethod"));
  }
  @Test void expiredClaimAndSignedInSessionCannotCreateAccount(){
    var f=new Fixture();f.pending();w.db.update("UPDATE github_signup_claims SET expires_at=now()-interval '1 second' WHERE session_hash=?",f.binding());assertEquals("GITHUB_SIGNUP_INVALID",assertThrows(ApiError.class,()->f.service.completeSignup(f.request,f.name)).code);
    var other=new Fixture();other.pending();accounts.signIn(other.request,passwordAccount(other.name),1);assertEquals("GITHUB_SESSION_CHANGED",assertThrows(ApiError.class,()->other.service.completeSignup(other.request,"fresh-name")).code);
  }
  @Test void racingClaimsForSameIdentityCreateExactlyOneAccount()throws Exception{
    var f=new Fixture();f.pending();var second=new MockHttpServletRequest();second.getSession(true).setAttribute("githubCorrelation",AccountPasswords.token());w.db.update("INSERT INTO github_signup_claims(session_hash,github_id,login,expires_at) VALUES(?,?,?,now()+interval '10 minutes')",f.service.sessionBinding(second),f.githubId,f.name);
    var pool=Executors.newFixedThreadPool(2);var gate=new CountDownLatch(1);
    try{var a=pool.submit(()->{gate.await();try{f.service.completeSignup(f.request,f.name);return "ok";}catch(ApiError e){return e.code;}});var b=pool.submit(()->{gate.await();try{f.service.completeSignup(second,"other-"+f.githubId);return "ok";}catch(ApiError e){return e.code;}});gate.countDown();assertEquals(Set.of("ok","ACCOUNT_CONFLICT"),Set.of(a.get(10,TimeUnit.SECONDS),b.get(10,TimeUnit.SECONDS)));assertEquals(1,w.db.queryForObject("SELECT count(*) FROM github_links WHERE github_id=?",Integer.class,f.githubId));assertEquals(1,w.db.queryForObject("SELECT count(*) FROM accounts WHERE username IN (?,?)",Integer.class,f.name,"other-"+f.githubId));}finally{pool.shutdownNow();}
  }
  @Test void v8ConstraintsBlockPasswordBackdoorAndPreserveLongGithubUsername(){
    var f=new Fixture();f.pending();String name="a".repeat(39);f.service.completeSignup(f.request,name);String account=accounts.require(f.request);
    assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->w.db.update("UPDATE accounts SET password_hash='backdoor' WHERE id=?",uuid(account)));
    assertThrows(org.springframework.dao.DataIntegrityViolationException.class,()->w.db.update("UPDATE accounts SET email='backdoor@example.invalid' WHERE id=?",uuid(account)));
    assertEquals(name,accounts.user(account,true).get("username"));
  }
}
