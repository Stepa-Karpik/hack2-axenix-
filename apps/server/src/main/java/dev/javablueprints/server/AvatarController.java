package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;

import jakarta.servlet.http.HttpServletRequest;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.*;
import java.security.MessageDigest;
import java.util.*;
import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1")
class AvatarController {
  static final int MAX_BYTES = 2 * 1024 * 1024;
  final Accounts accounts;
  final Workspace w;

  AvatarController(Accounts accounts, Workspace w) {
    this.accounts = accounts;
    this.w = w;
  }

  @PostMapping(value = "/profile/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
  Object upload(@RequestParam("file") MultipartFile file, HttpServletRequest request) {
    String actor = accounts.require(request);
    accounts.throttle("avatar", actor, 30);
    byte[] image = normalize(file);
    String version;
    try {
      version = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(image));
    } catch (java.security.NoSuchAlgorithmException e) {
      throw new IllegalStateException(e);
    }
    w.db.update(
        "INSERT INTO account_avatars(account_id,version,image) VALUES(?,?,?) ON CONFLICT(account_id)"
            + " DO UPDATE SET version=excluded.version,image=excluded.image",
        uuid(actor), version, image);
    return map("data", accounts.user(actor, true), "meta", map("requestId", id()));
  }

  @DeleteMapping("/profile/avatar")
  Object remove(HttpServletRequest request) {
    String actor = accounts.require(request);
    accounts.throttle("avatar", actor, 30);
    w.db.update("DELETE FROM account_avatars WHERE account_id=?", uuid(actor));
    return map("data", accounts.user(actor, true), "meta", map("requestId", id()));
  }

  @GetMapping("/users/{username}/avatar")
  ResponseEntity<byte[]> image(@PathVariable String username,
      @RequestParam(required = false) String v, HttpServletRequest request) {
    var rows = w.db.queryForList(
        "SELECT av.version,av.image FROM account_avatars av JOIN accounts a ON a.id=av.account_id"
            + " WHERE lower(a.username)=lower(?)", username);
    if (rows.isEmpty()) throw missing();
    var row = rows.getFirst();
    String version = row.get("version").toString();
    if (v != null && !version.equals(v)) throw missing();
    String etag = "\"" + version + "\"";
    var builder = ResponseEntity.status(etag.equals(request.getHeader("If-None-Match")) ? 304 : 200)
        .contentType(MediaType.IMAGE_PNG)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "public, max-age=0, must-revalidate")
        .eTag(etag);
    if (etag.equals(request.getHeader("If-None-Match"))) return builder.build();
    byte[] image = (byte[]) row.get("image");
    return builder.contentLength(image.length).body(image);
  }

  static byte[] normalize(MultipartFile file) {
    if (file.isEmpty()) throw invalid();
    if (file.getSize() > MAX_BYTES) throw tooLarge();
    try (var stream = file.getInputStream()) {
      byte[] bytes = stream.readNBytes(MAX_BYTES + 1);
      if (bytes.length > MAX_BYTES) throw tooLarge();
      // Inspect dimensions before decoding. Do not trust the filename or browser MIME type.
      try (var input = new MemoryCacheImageInputStream(new ByteArrayInputStream(bytes))) {
        var readers = ImageIO.getImageReaders(input);
        if (!readers.hasNext()) throw invalid();
        var reader = readers.next();
        try {
          String format = reader.getFormatName();
          if (!format.equalsIgnoreCase("PNG") && !format.equalsIgnoreCase("JPEG")) throw invalid();
          reader.setInput(input, true, true);
          int width = reader.getWidth(0), height = reader.getHeight(0);
          if (width < 1 || height < 1 || width > 4096 || height > 4096
              || (long) width * height > 8_000_000) throw invalid();
          boolean[] warned = {false};
          reader.addIIOReadWarningListener((ignored, warning) -> warned[0] = true);
          BufferedImage source = reader.read(0);
          if (warned[0]) {
            if (source != null) source.flush();
            throw invalid();
          }
          int side = Math.min(width, height), size = Math.min(side, 512);
          var target = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
          var graphics = target.createGraphics();
          try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION,
                RenderingHints.VALUE_INTERPOLATION_BICUBIC);
            int x = (width - side) / 2, y = (height - side) / 2;
            graphics.drawImage(source, 0, 0, size, size, x, y, x + side, y + side, null);
          } finally {
            graphics.dispose();
            source.flush();
          }
          var output = new ByteArrayOutputStream();
          ImageIO.write(target, "PNG", output);
          target.flush();
          return output.toByteArray();
        } finally {
          reader.dispose();
        }
      }
    } catch (IOException | IllegalArgumentException e) {
      throw invalid();
    }
  }

  static ApiError invalid() {
    return new ApiError(400, "INVALID_AVATAR", "Choose a valid PNG or JPEG, up to 4096 pixels per side and 8 megapixels");
  }

  static ApiError tooLarge() {
    return new ApiError(413, "AVATAR_TOO_LARGE", "Profile photo must be at most 2 MiB");
  }
}
