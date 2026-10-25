package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import static org.junit.jupiter.api.Assertions.*;

import java.awt.image.BufferedImage;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"jb.runner.enabled=false", "jb.origins=http://localhost:5174", "jb.smtp.host=",
        "spring.servlet.multipart.max-file-size=2MB", "spring.servlet.multipart.max-request-size=3MB"})
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AvatarIntegrationTest {
  static final String SCHEMA = "jbavatartest_" + UUID.randomUUID().toString().replace("-", "");
  @org.springframework.test.context.DynamicPropertySource
  static void database(org.springframework.test.context.DynamicPropertyRegistry p) {
    p.add("spring.flyway.default-schema", () -> SCHEMA);
    p.add("spring.flyway.schemas", () -> SCHEMA);
    p.add("spring.datasource.hikari.schema", () -> SCHEMA);
  }
  @Autowired Workspace w;
  @LocalServerPort int port;

  @AfterAll void cleanup() {
    assertTrue(SCHEMA.matches("jbavatartest_[a-f0-9]{32}"));
    w.db.execute("DROP SCHEMA " + SCHEMA + " CASCADE");
  }

  class Client {
    final HttpClient http = HttpClient.newBuilder()
        .cookieHandler(new CookieManager(null, CookiePolicy.ACCEPT_ALL)).build();
    String csrf;
    Client() throws Exception {
      csrf = data(send("GET", "/session", null, null, true)).get("csrfToken").toString();
    }
    HttpResponse<byte[]> send(String method, String path, byte[] bytes, String type, boolean token)
        throws Exception {
      var request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/api/v1" + path))
          .header("Origin", "http://localhost:5174");
      if (token && csrf != null) request.header("X-CSRF-Token", csrf);
      if (type != null) request.header("Content-Type", type);
      return http.send(request.method(method, bytes == null ? HttpRequest.BodyPublishers.noBody()
          : HttpRequest.BodyPublishers.ofByteArray(bytes)).build(), HttpResponse.BodyHandlers.ofByteArray());
    }
    void login(String name) throws Exception {
      var reply = send("POST", "/auth/login", w.encode(map("identifier", name,
          "password", "avatar-password-123")).getBytes(StandardCharsets.UTF_8), "application/json", true);
      assertEquals(200, reply.statusCode());
      csrf = data(reply).get("csrfToken").toString();
    }
    HttpResponse<byte[]> upload(byte[] image, String extra, boolean token) throws Exception {
      var body = new ByteArrayOutputStream();
      body.write(("--avatarboundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"photo.png\""
          + "\r\nContent-Type: image/png\r\n\r\n").getBytes(StandardCharsets.UTF_8));
      body.write(image);
      body.write(("\r\n" + extra + "--avatarboundary--\r\n").getBytes(StandardCharsets.UTF_8));
      return send("POST", "/profile/avatar", body.toByteArray(), "multipart/form-data; boundary=avatarboundary", token);
    }
  }
  Map<String, Object> data(HttpResponse<byte[]> response) {
    return (Map<String, Object>) w.decode(new String(response.body(), StandardCharsets.UTF_8)).get("data");
  }
  String account(String username) {
    String actor = id();
    w.db.update("INSERT INTO accounts(id,username,email,password_hash,display_name)VALUES(?,?,?,?,?)",
        uuid(actor), username, username + "@example.com", AccountPasswords.encode("avatar-password-123"), username);
    return actor;
  }
  byte[] picture(String format, int width, int height) throws Exception {
    var image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
    image.setRGB(width / 2, height / 2, 0xffeebb);
    var out = new ByteArrayOutputStream();
    assertTrue(ImageIO.write(image, format, out));
    return out.toByteArray();
  }

  @Test void boundedPhotosAreOwnedNormalizedPublicAndRemovable() throws Exception {
    String firstName = "avatar_" + id().replace("-", "").substring(0, 12);
    String secondName = "avatar_" + id().replace("-", "").substring(0, 12);
    String firstId = account(firstName), secondId = account(secondName);
    var first = new Client(); var second = new Client(); var anonymous = new Client();
    assertNull(data(first.send("GET", "/users/" + firstName, null, null, true)).get("avatarUrl"));
    first.login(firstName); second.login(secondName);
    byte[] png = picture("PNG", 800, 600);
    assertEquals(403, first.upload(png, "", false).statusCode());
    assertEquals(401, anonymous.upload(png, "", true).statusCode());
    var uploaded = first.upload(png, "", true);
    assertEquals(200, uploaded.statusCode(), new String(uploaded.body()));
    String url = data(uploaded).get("avatarUrl").toString();
    assertEquals(url, data(anonymous.send("GET", "/users/" + firstName, null, null, true)).get("avatarUrl"));
    var fetched = anonymous.send("GET", url.substring("/api/v1".length()), null, null, true);
    assertEquals(200, fetched.statusCode());
    assertEquals("image/png", fetched.headers().firstValue("Content-Type").orElseThrow());
    assertEquals("nosniff", fetched.headers().firstValue("X-Content-Type-Options").orElseThrow());
    assertEquals("public, max-age=0, must-revalidate", fetched.headers().firstValue("Cache-Control").orElseThrow());
    assertEquals(512, ImageIO.read(new ByteArrayInputStream(fetched.body())).getWidth());
    assertEquals(512, ImageIO.read(new ByteArrayInputStream(fetched.body())).getHeight());
    var conditional = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + url))
        .header("If-None-Match", fetched.headers().firstValue("ETag").orElseThrow()).GET().build();
    assertEquals(304, anonymous.http.send(conditional, HttpResponse.BodyHandlers.discarding()).statusCode());
    byte[] jpeg = picture("JPEG", 40, 60);
    for (byte[] invalid : List.of("<svg/>".getBytes(), "GIF89a".getBytes(), new byte[] {1,2,3}, Arrays.copyOf(png, 20), Arrays.copyOf(jpeg, jpeg.length - 5), picture("PNG", 4097, 1), picture("PNG", 3000, 3000)))
      assertEquals(400, first.upload(invalid, "", true).statusCode());
    assertEquals(413, first.upload(new byte[AvatarController.MAX_BYTES + 1], "", true).statusCode());
    assertEquals(url, data(first.send("GET", "/profile", null, null, true)).get("avatarUrl"));
    var secondUpload = second.upload(picture("JPEG", 40, 60),
        "--avatarboundary\r\nContent-Disposition: form-data; name=\"accountId\"\r\n\r\n" + firstId + "\r\n", true);
    assertEquals(200, secondUpload.statusCode());
    assertTrue(data(secondUpload).get("avatarUrl").toString().contains(secondName));
    assertEquals(url, data(first.send("GET", "/profile", null, null, true)).get("avatarUrl"));
    assertEquals(1, w.db.queryForObject("SELECT count(*) FROM account_avatars WHERE account_id=?", Integer.class, uuid(secondId)));
    assertEquals(403, first.send("DELETE", "/profile/avatar", null, null, false).statusCode());
    assertNull(data(second.send("DELETE", "/profile/avatar", null, null, true)).get("avatarUrl"));
    assertEquals(200, anonymous.send("GET", url.substring("/api/v1".length()), null, null, true).statusCode());
    String replacement = data(first.upload(picture("JPEG", 20, 20), "", true)).get("avatarUrl").toString();
    assertNotEquals(url, replacement);
    assertEquals(404, anonymous.send("GET", url.substring("/api/v1".length()), null, null, true).statusCode());
    assertNull(data(first.send("DELETE", "/profile/avatar", null, null, true)).get("avatarUrl"));
    assertEquals(404, anonymous.send("GET", replacement.substring("/api/v1".length()), null, null, true).statusCode());
  }
}
