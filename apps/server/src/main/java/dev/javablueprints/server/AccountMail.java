package dev.javablueprints.server;

import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.net.ssl.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Implicit TLS SMTP (Yandex port 465); certificate and host verification stay enabled. */
@Component
class AccountMail {
  final String host, username, password, from, baseUrl;
  final int port;

  AccountMail(
      @Value("${jb.smtp.host:}") String host,
      @Value("${jb.smtp.port:465}") String port,
      @Value("${jb.smtp.username:}") String username,
      @Value("${jb.smtp.password:}") String password,
      @Value("${jb.smtp.from:}") String from,
      @Value("${jb.public-url:http://127.0.0.1:5174}") String baseUrl) {
    this.host = host;
    this.port = port.isBlank() ? 465 : Integer.parseInt(port);
    this.username = username;
    this.password = password;
    this.from = from;
    this.baseUrl = baseUrl.isBlank() ? "http://127.0.0.1:5174" : baseUrl;
  }

  boolean available() {
    return !host.isBlank() && !username.isBlank() && !password.isBlank() && validAddress(from);
  }

  static boolean validAddress(String value) {
    return value != null
        && value.length() <= 254
        && value.matches("[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}");
  }

  void send(String email, String kind, String token) {
    if (!available()) throw unavailable();
    if (!validAddress(email)) throw new ApiError(400, "INVALID_EMAIL", "Invalid email address");
    try (var tcp = new Socket()) {
      tcp.connect(new InetSocketAddress(host, port), 8000);
      tcp.setSoTimeout(8000);
      try (var socket =
          (SSLSocket)
              ((SSLSocketFactory) SSLSocketFactory.getDefault())
                  .createSocket(tcp, host, port, true)) {
        var parameters = socket.getSSLParameters();
        parameters.setEndpointIdentificationAlgorithm("HTTPS");
        socket.setSSLParameters(parameters);
        socket.startHandshake();
        var reader =
            new BufferedReader(
                new InputStreamReader(socket.getInputStream(), StandardCharsets.US_ASCII));
        var writer =
            new BufferedWriter(
                new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.US_ASCII));
        expect(reader, 220);
        command(writer, reader, "EHLO localhost", 250);
        command(writer, reader, "AUTH LOGIN", 334);
        command(
            writer,
            reader,
            Base64.getEncoder().encodeToString(username.getBytes(StandardCharsets.UTF_8)),
            334);
        command(
            writer,
            reader,
            Base64.getEncoder().encodeToString(password.getBytes(StandardCharsets.UTF_8)),
            235);
        command(writer, reader, "MAIL FROM:<" + from + ">", 250);
        command(writer, reader, "RCPT TO:<" + email + ">", 250);
        command(writer, reader, "DATA", 354);
        String route = kind.equals("verify") ? "verify-email" : "reset-password";
        String body =
            "Привет!\r\n\r\n"
                + (kind.equals("verify")
                    ? "Ты зарегистрировался в Java Blueprints. Подтверди почту по ссылке:"
                    : "Ты запросил восстановление пароля в Java Blueprints. Задай новый пароль по ссылке:")
                + "\r\n"
                + baseUrl.replaceAll("/$", "")
                + "/"
                + route
                + "?token="
                + token
                + "\r\n\r\n"
                + (kind.equals("verify") ? "Ссылка действует 24 часа." : "Ссылка действует один час.")
                + "\r\nЕсли ты этого не делал, просто проигнорируй письмо.";
        String subject = "=?UTF-8?B?"
            + Base64.getEncoder().encodeToString((kind.equals("verify")
                ? "Java Blueprints — подтверждение почты"
                : "Java Blueprints — восстановление пароля").getBytes(StandardCharsets.UTF_8))
            + "?=";
        writer.write(
            "From: <"
                + from
                + ">\r\nTo: <"
                + email
                + ">\r\nSubject: "
                + subject
                + "\r\n"
                + "MIME-Version: 1.0\r\n"
                + "Content-Type: text/plain; charset=UTF-8\r\n"
                + "Content-Transfer-Encoding: base64\r\n\r\n"
                + Base64.getMimeEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8))
                + "\r\n.\r\n");
        writer.flush();
        expect(reader, 250);
      }
    } catch (IOException | RuntimeException e) {
      throw unavailable();
    }
  }

  static ApiError unavailable() {
    return new ApiError(
        503,
        "SMTP_UNAVAILABLE",
        "Email delivery unavailable; configure JB_SMTP_HOST, JB_SMTP_PORT (implicit TLS),"
            + " JB_SMTP_USERNAME, JB_SMTP_PASSWORD, JB_SMTP_FROM and JB_PUBLIC_URL");
  }

  private static void command(BufferedWriter w, BufferedReader r, String value, int code)
      throws IOException {
    w.write(value + "\r\n");
    w.flush();
    expect(r, code);
  }

  private static void expect(BufferedReader reader, int code) throws IOException {
    for (int lines = 0; lines < 100; lines++) {
      String line = reader.readLine();
      if (line == null || line.length() < 3 || !line.startsWith(Integer.toString(code)))
        throw new IOException("SMTP command rejected");
      if (line.length() < 4 || line.charAt(3) != '-') return;
    }
    throw new IOException("SMTP response too long");
  }
}
