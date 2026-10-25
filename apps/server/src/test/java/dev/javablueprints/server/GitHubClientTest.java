package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;
import static dev.javablueprints.server.Workspace.*;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class GitHubClientTest {
  static GitHubConfig config(){return new GitHubConfig("client-fixture","secret-fixture",Base64.getEncoder().encodeToString(new byte[32]),"http://127.0.0.1:5174/api/v1/github/oauth/callback");}
  static GitHubClient.Reply json(int status,Object value){return new GitHubClient.Reply(status,Map.of(),ProjectArchiveCodec.bytes(value));}
  @Test void unconfiguredAndInvalidCallbackRemainDisabledWithoutCrashingStartup(){
    assertFalse(new GitHubConfig("","","","").configured());
    assertFalse(new GitHubConfig("client","secret",Base64.getEncoder().encodeToString(new byte[32]),"http://attacker.test/api/v1/github/oauth/callback").configured());
    assertTrue(config().configured());
  }
  @Test void encryptedTokensHaveIndependentNoncesAndAuthenticatedContext(){
    var crypto=new GitHubCrypto(config().key);String first=crypto.seal("fixture-token","account-a"),second=crypto.seal("fixture-token","account-a");
    assertNotEquals(first,second);assertFalse(first.contains("fixture-token"));assertEquals("fixture-token",crypto.open(first,"account-a"));
    assertThrows(ApiError.class,()->crypto.open(first,"account-b"));
    assertThrows(ApiError.class,()->crypto.open(first.substring(0,first.length()-4)+"AAAA","account-a"));
  }
  @Test void exchangeUsesPostBodyPkceAndFixedProviderOriginWithoutPuttingSecretsInUrl(){
    var client=new GitHubClient((method,uri,headers,body,limit)->{
      assertEquals("POST",method);assertEquals("https://github.com/login/oauth/access_token",uri.toString());assertNull(uri.getQuery());
      String form=URLDecoder.decode(new String(body,StandardCharsets.UTF_8),StandardCharsets.UTF_8);
      assertTrue(form.contains("client_secret=secret-fixture"));assertTrue(form.contains("code_verifier=verifier-fixture"));assertTrue(form.contains("code=code-fixture"));
      assertEquals("application/json",headers.get("Accept"));return json(200,map("access_token","token-fixture","scope","repo"));
    });
    assertEquals("token-fixture",client.exchange(config(),"code-fixture","verifier-fixture").get("access_token"));
  }
  @Test void redirectsAndRateLimitsAreExplicitAndNeverRetried(){
    var calls=new AtomicInteger();var rate=new GitHubClient((m,u,h,b,l)->{calls.incrementAndGet();return new GitHubClient.Reply(429,Map.of("Retry-After",List.of("60")),new byte[0]);});
    var failure=assertThrows(ApiError.class,()->rate.get("/user","fixture",100));assertEquals("GITHUB_RATE_LIMITED",failure.code);assertTrue(failure.getMessage().contains("60"));assertEquals(1,calls.get());
    var redirect=new GitHubClient((m,u,h,b,l)->new GitHubClient.Reply(302,Map.of("Location",List.of("http://127.0.0.1/private")),new byte[0]));
    assertEquals("GITHUB_REDIRECT_REJECTED",assertThrows(ApiError.class,()->redirect.get("/user","fixture",100)).code);
  }
  @Test void bodyBudgetAndBlobChecksumCannotBeBypassed(){
    var oversized=new GitHubClient((m,u,h,b,l)->new GitHubClient.Reply(200,Map.of(),new byte[11]));assertThrows(ApiError.class,()->oversized.get("/user","fixture",10));
    String sha="a".repeat(40);var mismatch=new GitHubClient((m,u,h,b,l)->json(200,map("sha",sha,"encoding","base64","content",Base64.getEncoder().encodeToString("changed".getBytes(StandardCharsets.UTF_8)))));
    assertEquals("GITHUB_RESPONSE_INVALID",assertThrows(ApiError.class,()->mismatch.blob("/repos/user/demo",sha,"fixture")).code);
  }
}
