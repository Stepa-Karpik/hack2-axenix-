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

class GitHubCancellationTest {
  @Test void unchangedConsumedAttemptAtomicallyLinksIdentityAndRepositoryGrant() {
    var db=mock(JdbcTemplate.class);var accounts=mock(Accounts.class);
    var request=new MockHttpServletRequest();request.getSession(true).setAttribute("githubCorrelation","browser-fixture");
    String account=id(),state=AccountPasswords.token();var config=GitHubClientTest.config();
    when(accounts.actor(request)).thenReturn(account);
    when(db.queryForObject(eq("SELECT auth_version FROM accounts WHERE id=?"),eq(Integer.class),eq(uuid(account)))).thenReturn(3);
    when(db.queryForObject(eq("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE"),eq(Integer.class),eq(uuid(account)))).thenReturn(3);
    when(db.queryForList(startsWith("UPDATE github_oauth_attempts"),eq(hash(state)),eq(hash("browser-fixture"))))
        .thenReturn(List.of(map("purpose","link","account_id",account,"auth_version",3,"verifier_ciphertext",new GitHubCrypto(config.key).seal("verifier","pkce|"+hash(state)))));
    when(db.queryForList(startsWith("SELECT state_hash FROM github_oauth_attempts"),eq(hash(state)),eq(hash("browser-fixture")),eq("link"),eq(uuid(account)),eq(3)))
        .thenReturn(List.of(map("state_hash",hash(state))));
    var client=new GitHubClient((method,uri,headers,body,limit)->GitHubClientTest.json(200,method.equals("POST")?map("access_token","fixture","scope","repo"):map("id",111,"login","same-name")));
    var service=new GitHubService(new Workspace(db,mock(PlatformTransactionManager.class)),accounts,config,client);
    assertEquals("/settings/integrations?github=link_success",service.callback(request,state,"code",null));
    verify(db).update(startsWith("INSERT INTO github_links"),eq(uuid(account)),eq("111"),eq("same-name"));
    assertTrue(mockingDetails(db).getInvocations().stream().anyMatch(call->call.getMethod().getName().equals("update")&&call.getArguments()[0].toString().startsWith("INSERT INTO github_credentials")));
  }
  @Test void explicitUnlinkDuringProviderExchangeCancelsBothLinkAndRepositoryCallbacks(){
    for(String purpose:List.of("link","repositories")) {
      JdbcTemplate db=mock(JdbcTemplate.class);
      Workspace workspace=new Workspace(db,mock(PlatformTransactionManager.class));
      Accounts accounts=mock(Accounts.class);
      var request=new MockHttpServletRequest();request.getSession(true).setAttribute("githubCorrelation","browser-fixture");
      String account=id(),state=AccountPasswords.token();int version=3;
      var config=GitHubClientTest.config();
      when(accounts.actor(request)).thenReturn(account);when(accounts.require(request)).thenReturn(account);
      when(db.queryForObject(eq("SELECT auth_version FROM accounts WHERE id=?"),eq(Integer.class),eq(uuid(account)))).thenReturn(version);
      when(db.queryForObject(eq("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE"),eq(Integer.class),eq(uuid(account)))).thenReturn(version);
      when(db.queryForObject(eq("SELECT id FROM accounts WHERE id=? FOR UPDATE"),eq(UUID.class),eq(uuid(account)))).thenReturn(uuid(account));
      var attemptExists=new AtomicBoolean(true);var consumed=new AtomicBoolean();
      var attempt=map("purpose",purpose,"account_id",account,"auth_version",version,"verifier_ciphertext",new GitHubCrypto(config.key).seal("verifier-fixture","pkce|"+hash(state)));
      when(db.queryForList(startsWith("UPDATE github_oauth_attempts"),eq(hash(state)),eq(hash("browser-fixture")))).thenAnswer(call->{assertTrue(attemptExists.get());assertFalse(consumed.getAndSet(true));return List.of(attempt);});
      when(db.update(eq("DELETE FROM github_oauth_attempts WHERE account_id=?"),eq(uuid(account)))).thenAnswer(call->{attemptExists.set(false);return 1;});
      when(db.queryForList(startsWith("SELECT state_hash FROM github_oauth_attempts"),eq(hash(state)),eq(hash("browser-fixture")),eq(purpose),eq(uuid(account)),eq(version)))
          .thenAnswer(call->attemptExists.get()&&consumed.get()?List.of(map("state_hash",hash(state))):List.of());
      GitHubService[] service=new GitHubService[1];
      var client=new GitHubClient((method,uri,headers,body,limit)->{
        if(method.equals("POST")) {
          // Exact race barrier: state is already consumed, but callback has not acquired account lock.
          assertTrue(consumed.get());service[0].unlink(request);assertFalse(attemptExists.get());
          return GitHubClientTest.json(200,map("access_token","token-fixture","scope","repo"));
        }
        return GitHubClientTest.json(200,map("id",111,"login","same-name"));
      });
      service[0]=new GitHubService(workspace,accounts,config,client);
      var failure=assertThrows(ApiError.class,()->service[0].callback(request,state,"code",null),purpose);
      assertEquals("GITHUB_STATE_INVALID",failure.code);assertTrue(failure.getMessage().contains("cancelled"));
      verify(db).update("DELETE FROM github_links WHERE account_id=?",uuid(account));
      verify(db,never()).update(startsWith("INSERT INTO github_links"),eq(uuid(account)),eq("111"),eq("same-name"));
      assertTrue(mockingDetails(db).getInvocations().stream().noneMatch(call->call.getMethod().getName().equals("update")&&call.getArguments()[0].toString().startsWith("INSERT INTO github_credentials")));
      var order=inOrder(db);
      order.verify(db).queryForObject("SELECT id FROM accounts WHERE id=? FOR UPDATE",UUID.class,uuid(account));
      order.verify(db).update("DELETE FROM github_links WHERE account_id=?",uuid(account));
      order.verify(db).update("DELETE FROM github_oauth_attempts WHERE account_id=?",uuid(account));
      order.verify(db).queryForObject("SELECT auth_version FROM accounts WHERE id=? FOR UPDATE",Integer.class,uuid(account));
    }
  }
}
