package dev.javablueprints.server;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class GitHubCrypto {
  private static final SecureRandom RANDOM=new SecureRandom();
  private final byte[] key;
  GitHubCrypto(byte[] key){this.key=key.clone();}
  String seal(String text,String context){
    try {
      byte[] nonce=new byte[12];RANDOM.nextBytes(nonce);
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
      cipher.updateAAD(("github-v1|"+context).getBytes(StandardCharsets.UTF_8));
      return "v1:"+Base64.getEncoder().encodeToString(nonce)+":"+Base64.getEncoder().encodeToString(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)));
    }catch(Exception ignored){throw new ApiError(503,"GITHUB_CREDENTIAL_UNAVAILABLE","GitHub credential encryption is unavailable");}
  }
  String open(String value,String context){
    try{
      String[] parts=value.split(":",-1);if(parts.length!=3||!parts[0].equals("v1"))throw new IllegalArgumentException();
      byte[] nonce=Base64.getDecoder().decode(parts[1]);if(nonce.length!=12)throw new IllegalArgumentException();
      Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
      cipher.updateAAD(("github-v1|"+context).getBytes(StandardCharsets.UTF_8));
      return new String(cipher.doFinal(Base64.getDecoder().decode(parts[2])),StandardCharsets.UTF_8);
    }catch(Exception ignored){throw new ApiError(409,"GITHUB_RECONNECT","GitHub credential cannot be read; reconnect GitHub");}
  }
}
