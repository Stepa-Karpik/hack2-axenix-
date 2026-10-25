package dev.javablueprints.server;

import static dev.javablueprints.server.Workspace.*;
import java.io.InputStream;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.*;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Fixed provider origins; no URLs from browser or GitHub response are followed. */
@Component
final class GitHubClient {
  record Reply(int status,Map<String,List<String>> headers,byte[] body){}
  interface Transport {Reply send(String method,URI uri,Map<String,String> headers,byte[] body,int limit)throws Exception;}
  private static final JsonMapper JSON=JsonMapper.builder().build();
  private final Transport transport;
  GitHubClient(){
    HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build();
    transport=(method,uri,headers,body,limit)->{
      var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(15));headers.forEach(request::header);
      request.method(method,body.length==0?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofByteArray(body));
      var response=client.send(request.build(),HttpResponse.BodyHandlers.ofInputStream());
      try(InputStream input=response.body()){
        byte[] bytes=input.readNBytes(limit+1);if(bytes.length>limit)throw error(413,"GITHUB_INPUT_LIMIT","GitHub response exceeds the bounded import limit");
        return new Reply(response.statusCode(),response.headers().map(),bytes);
      }
    };
  }
  GitHubClient(Transport transport){this.transport=transport;}
  static String segment(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20");}
  static String sha(Object value){String sha=Objects.toString(value,"");if(!sha.matches("[a-f0-9]{40}|[a-f0-9]{64}"))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub object identity");return sha;}
  static String numeric(Object value){String id=Objects.toString(value,"");if(!id.matches("[1-9][0-9]{0,19}"))throw error(400,"GITHUB_ID_INVALID","Invalid GitHub identifier");return id;}
  static Map<String,Object> object(Object value){if(!(value instanceof Map<?,?>))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub response");return (Map<String,Object>)value;}
  static List<Map<String,Object>> list(Object value){if(!(value instanceof List<?> list))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub list");return list.stream().map(GitHubClient::object).toList();}
  Object get(String path,String token,int limit){return call("GET",URI.create("https://api.github.com"+path),token,new byte[0],limit);}
  Map<String,Object> exchange(GitHubConfig config,String code,String verifier){
    String body="client_id="+segment(config.clientId)+"&client_secret="+segment(config.clientSecret)+"&code="+segment(code)+"&redirect_uri="+segment(config.callback)+"&code_verifier="+segment(verifier);
    var result=object(call("POST",URI.create("https://github.com/login/oauth/access_token"),null,body.getBytes(StandardCharsets.UTF_8),65536));
    if(result.containsKey("error")||!(result.get("access_token") instanceof String token)||token.isBlank()||token.length()>4096||token.chars().anyMatch(c->c<=32||c>=127))
      throw error(401,"GITHUB_AUTH_FAILED","GitHub authorization failed; start again");
    return result;
  }
  Map<String,Object> refresh(GitHubConfig config,String refreshToken){
    String body="client_id="+segment(config.clientId)+"&client_secret="+segment(config.clientSecret)+"&grant_type=refresh_token&refresh_token="+segment(refreshToken);
    var result=object(call("POST",URI.create("https://github.com/login/oauth/access_token"),null,body.getBytes(StandardCharsets.UTF_8),65536));
    if(result.containsKey("error"))throw error(401,"GITHUB_RECONNECT","GitHub refresh failed; reconnect repository access");
    return result;
  }
  record TokenPair(String access,String refresh,java.time.Instant expires,java.time.Instant refreshExpires,String scope){}
  static TokenPair tokenPair(Map<String,Object> result,boolean rotation){
    String access=tokenValue(result.get("access_token"));
    if(result.get("token_type")!=null&&!"bearer".equalsIgnoreCase(Objects.toString(result.get("token_type"))))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub token type");
    boolean expiring=result.containsKey("expires_in")||result.containsKey("refresh_token")||result.containsKey("refresh_token_expires_in");
    if(rotation&&!expiring)throw error(502,"GITHUB_RESPONSE_INVALID","Missing GitHub rotating token pair");
    var now=java.time.Instant.now();
    return new TokenPair(access,expiring?tokenValue(result.get("refresh_token")):null,
        expiring?now.plusSeconds(lifetime(result.get("expires_in"))):null,
        expiring?now.plusSeconds(lifetime(result.get("refresh_token_expires_in"))):null,
        Objects.toString(result.get("scope"),""));
  }
  private static String tokenValue(Object value){
    if(!(value instanceof String token)||token.isBlank()||token.length()>4096||token.chars().anyMatch(c->c<=32||c>=127))throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub token response");
    return token;
  }
  private static long lifetime(Object value){
    if(value instanceof Number number){
      try{
        // JSON exponent notation may decode to Double; accept only an exact whole second.
        long seconds=new java.math.BigDecimal(number.toString()).longValueExact();
        if(seconds>0&&seconds<=366L*24*3600)return seconds;
      }catch(NumberFormatException|ArithmeticException ignored){}
    }
    throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub token expiry");
  }
  private Object call(String method,URI uri,String token,byte[] body,int limit){
    if(!Set.of("api.github.com","github.com").contains(uri.getHost())||!"https".equals(uri.getScheme())||uri.getPort()!=-1||uri.getUserInfo()!=null)
      throw error(400,"GITHUB_URL_REJECTED","GitHub endpoint is not allowed");
    var headers=new LinkedHashMap<String,String>();headers.put("Accept","application/vnd.github+json");headers.put("User-Agent","JavaBlueprints");headers.put("X-GitHub-Api-Version","2026-03-10");
    if(token!=null)headers.put("Authorization","Bearer "+token);
    if(method.equals("POST")){headers.put("Accept","application/json");headers.put("Content-Type","application/x-www-form-urlencoded");}
    Reply response;
    try{response=transport.send(method,uri,headers,body,limit);}catch(ApiError e){throw e;}catch(Exception ignored){throw error(502,"GITHUB_UNAVAILABLE","GitHub is unavailable; retry this action later");}
    if(response.body().length>limit)throw error(413,"GITHUB_INPUT_LIMIT","GitHub response exceeds the bounded import limit");
    int status=response.status();
    if(status>=300&&status<400)throw error(502,"GITHUB_REDIRECT_REJECTED","GitHub repository moved; reselect the repository");
    if(status==401)throw error(401,"GITHUB_RECONNECT","GitHub authorization expired or was revoked; reconnect");
    if(status==429||(status==403&&(header(response,"x-ratelimit-remaining").equals("0")||!header(response,"retry-after").isEmpty()))) {
      String retry=header(response,"retry-after"),reset=header(response,"x-ratelimit-reset");
      throw error(429,"GITHUB_RATE_LIMITED","GitHub request limit reached"+(retry.matches("[0-9]{1,10}")?"; retry after "+retry+" seconds":reset.matches("[0-9]{1,12}")?"; reset at Unix "+reset:"") );
    }
    if(status==403)throw error(403,"GITHUB_ACCESS_DENIED","GitHub denied repository access; check permissions or organization authorization");
    if(status==404)throw error(404,"GITHUB_NOT_FOUND","GitHub repository or ref is unavailable");
    if(status<200||status>=300)throw error(502,"GITHUB_REQUEST_FAILED","GitHub could not complete this request");
    try{return JSON.readValue(TextTree.decode(response.body()),Object.class);}catch(Exception ignored){throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub response");}
  }
  private String header(Reply reply,String name){return reply.headers().entrySet().stream().filter(e->e.getKey().equalsIgnoreCase(name)).map(e->e.getValue().isEmpty()?"":e.getValue().getFirst()).findFirst().orElse("");}
  byte[] blob(String repository,String sha,String token){
    var value=object(get(repository+"/git/blobs/"+sha,token,2*TextTree.MAX_BYTES));
    if(!sha.equals(value.get("sha"))||!"base64".equals(value.get("encoding")))throw error(502,"GITHUB_RESPONSE_INVALID","GitHub blob identity differs");
    try{
      String encoded=Objects.toString(value.get("content"),"");
      if(encoded.length()>2*TextTree.MAX_BYTES)throw new IllegalArgumentException();
      byte[] bytes=Base64.getDecoder().decode(encoded.replace("\n","").replace("\r",""));
      if(bytes.length>TextTree.MAX_BYTES)throw error(413,"GITHUB_INPUT_LIMIT","Selected file exceeds 1MiB");
      var digest=MessageDigest.getInstance(sha.length()==40?"SHA-1":"SHA-256");digest.update(("blob "+bytes.length+"\0").getBytes(StandardCharsets.US_ASCII));
      if(!HexFormat.of().formatHex(digest.digest(bytes)).equals(sha))throw error(502,"GITHUB_RESPONSE_INVALID","GitHub blob checksum differs");
      return bytes;
    }catch(ApiError e){throw e;}catch(Exception ignored){throw error(502,"GITHUB_RESPONSE_INVALID","Invalid GitHub blob encoding");}
  }
  static ApiError error(int status,String code,String message){return new ApiError(status,code,message);}
}
