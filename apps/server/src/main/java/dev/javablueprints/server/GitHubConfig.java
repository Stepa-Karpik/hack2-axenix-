package dev.javablueprints.server;

import java.net.URI;
import java.util.Base64;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
final class GitHubConfig {
  final String clientId, clientSecret, callback;
  final byte[] key;
  final String unavailableReason;
  GitHubConfig(@Value("${jb.github.client-id:${JB_GITHUB_CLIENT_ID:}}") String clientId,
      @Value("${jb.github.client-secret:${JB_GITHUB_CLIENT_SECRET:}}") String secret,
      @Value("${jb.github.token-key:${JB_GITHUB_TOKEN_KEY:}}") String key,
      @Value("${jb.github.callback-url:${JB_GITHUB_CALLBACK_URL:}}") String callback) {
    this.clientId=clientId.strip();this.clientSecret=secret;this.callback=callback.strip();
    byte[] decoded=null;String reason=null;
    try {
      if(this.clientId.isBlank()||secret.isBlank()||key.isBlank()||this.callback.isBlank()) throw new IllegalArgumentException();
      decoded=Base64.getDecoder().decode(key);
      if(decoded.length!=32||!this.clientId.matches("[A-Za-z0-9_.-]{1,200}"))throw new IllegalArgumentException();
      URI uri=URI.create(this.callback);
      boolean loopback="http".equals(uri.getScheme())&&("127.0.0.1".equals(uri.getHost())||"localhost".equals(uri.getHost()));
      if((!loopback&&!"https".equals(uri.getScheme()))||uri.getHost()==null||uri.getRawUserInfo()!=null||uri.getRawQuery()!=null||uri.getRawFragment()!=null
          ||!"/api/v1/github/oauth/callback".equals(uri.getPath()))throw new IllegalArgumentException();
    }catch(Exception ignored){reason="GitHub не настроен: администратор должен указать OAuth App, callback и ключ шифрования.";decoded=null;}
    this.key=decoded;this.unavailableReason=reason;
  }
  boolean configured(){return key!=null;}
  void require(){if(!configured())throw new ApiError(503,"GITHUB_UNCONFIGURED",unavailableReason);}
}
