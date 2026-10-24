package dev.javablueprints.server;

import java.security.*;
import java.util.*;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** Passwords use independent random salts; reset tokens are never stored in plaintext. */
final class AccountPasswords {
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final int ITERATIONS = 310_000;

  static String token() {
    byte[] bytes = new byte[32];
    RANDOM.nextBytes(bytes);
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  static String encode(String password) {
    if (password == null || password.length() < 12 || password.length() > 256)
      throw new ApiError(400, "INVALID_PASSWORD", "Password must contain 12..256 characters");
    byte[] salt = new byte[16];
    RANDOM.nextBytes(salt);
    return ITERATIONS
        + ":"
        + Base64.getEncoder().encodeToString(salt)
        + ":"
        + Base64.getEncoder().encodeToString(derive(password, salt, ITERATIONS));
  }

  static boolean matches(String password, String encoded) {
    if (password == null || password.length() > 256) return false;
    try {
      var parts = encoded.split(":");
      return MessageDigest.isEqual(
          Base64.getDecoder().decode(parts[2]),
          derive(password, Base64.getDecoder().decode(parts[1]), Integer.parseInt(parts[0])));
    } catch (RuntimeException e) {
      return false;
    }
  }

  private static byte[] derive(String password, byte[] salt, int rounds) {
    var spec = new PBEKeySpec(password.toCharArray(), salt, rounds, 256);
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
    } catch (GeneralSecurityException e) {
      throw new IllegalStateException("Password derivation unavailable");
    } finally {
      spec.clearPassword();
    }
  }
}
