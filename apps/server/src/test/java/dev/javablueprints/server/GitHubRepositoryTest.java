package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static dev.javablueprints.server.Workspace.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class GitHubRepositoryTest {
  final MockHttpServletRequest request=new MockHttpServletRequest();
  final GitHubService auth=mock(GitHubService.class);
  final List<String> calls=new ArrayList<>();
  byte[] overrideBytes;
  byte[] bytes(){return overrideBytes==null?source.getBytes(StandardCharsets.UTF_8):overrideBytes;}
  String mode="100644";boolean truncated=false;String source="\uFEFFПривет 😀\r\n";
  GitHubRepositoryTest(){when(auth.credential(request)).thenReturn(new GitHubService.Credential("account","42","token-fixture","grant"));when(auth.sessionBinding(request)).thenReturn("session");when(auth.authVersion("account")).thenReturn(1);}
  String blobSha(){try{byte[] bytes=bytes();var digest=MessageDigest.getInstance("SHA-1");digest.update(("blob "+bytes.length+"\0").getBytes(StandardCharsets.US_ASCII));return HexFormat.of().formatHex(digest.digest(bytes));}catch(Exception e){throw new RuntimeException(e);}}
  GitHubRepositoryService service(){
    var client=new GitHubClient((method,uri,headers,body,limit)->{
      calls.add(uri.getRawPath());assertEquals("GET",method);assertEquals("api.github.com",uri.getHost());
      Object value=switch(uri.getRawPath()){
        case "/repositories/7"->map("id",7,"name","demo","owner",map("login","owner"));
        case "/repos/owner/demo/commits/main"->map("sha","b".repeat(40),"commit",map("tree",map("sha","a".repeat(40))));
        case "/repos/owner/demo/git/trees/"+"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"->map("sha","a".repeat(40),"truncated",truncated,"tree",List.of(map("path","notes.txt","mode",mode,"type","blob","sha",blobSha(),"size",bytes().length)));
        default->{if(uri.getRawPath().equals("/repos/owner/demo/git/blobs/"+blobSha()))yield map("sha",blobSha(),"encoding","base64","content",Base64.getEncoder().encodeToString(bytes()));throw new AssertionError("Unexpected fixed API path");}
      };
      return GitHubClientTest.json(200,value);
    });return new GitHubRepositoryService(auth,client);
  }
  @Test void immutableSnapshotPreservesRawUtf8BomCrLfAndOnlyProducesSharedTextPreview(){
    var service=service();var snapshot=service.snapshot(request,"7","main");String id=snapshot.get("snapshotId").toString();
    var tree=service.tree(request,id,"");assertEquals(true,tree.get("complete"));
    var preview=service.preview(request,id,List.of("notes.txt"),List.of(),false);
    assertEquals(List.of(map("path","notes.txt","content",source)),preview.get("files"));
    assertEquals("b".repeat(40),GitHubClient.object(preview.get("provenance")).get("commitSha"));
    assertEquals(1,calls.stream().filter(p->p.contains("/commits/")).count());
    assertTrue(calls.stream().anyMatch(p->p.endsWith("/git/blobs/"+blobSha())));
  }
  @Test void treeTruncationCannotSilentlyReturnAnIncompletePreview(){
    truncated=true;var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertEquals("GITHUB_TREE_INCOMPLETE",assertThrows(ApiError.class,()->service.preview(request,id,List.of(),List.of(),true)).code);
    assertFalse(calls.stream().anyMatch(p->p.contains("/git/blobs/")));
  }
  @Test void symlinksUnknownPathsAndOverlappingSelectionsAreRefused(){
    mode="120000";var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertEquals("GITHUB_ENTRY_UNSUPPORTED",assertThrows(ApiError.class,()->service.preview(request,id,List.of("notes.txt"),List.of(),false)).code);
    assertThrows(ApiError.class,()->service.preview(request,id,List.of("../secret"),List.of(),false));
    assertThrows(ApiError.class,()->service.preview(request,id,List.of("other.txt"),List.of(),false));
  }
  @Test void binaryDataIsNotSilentlySkipped(){
    source="a\0b";var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertEquals("GITHUB_TEXT_REQUIRED",assertThrows(ApiError.class,()->service.preview(request,id,List.of(),List.of(),true)).code);
  }
  @Test void malformedUtf8IsRefusedWithoutReplacementCharacters() {
    overrideBytes=new byte[]{(byte)0xc3,0x28};var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertEquals("GITHUB_TEXT_REQUIRED",assertThrows(ApiError.class,()->service.preview(request,id,List.of("notes.txt"),List.of(),false)).code);
  }
  @Test void duplicateSelectedFilesCannotBeSilentlyCollapsed() {
    var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertEquals("GITHUB_PATH_INVALID",assertThrows(ApiError.class,()->service.preview(request,id,List.of("notes.txt","notes.txt"),List.of(),false)).code);
    assertFalse(calls.stream().anyMatch(p->p.contains("/git/blobs/")));
  }
  @Test void oversizedFileIsRefusedBeforeBlobDownload() {
    overrideBytes=new byte[TextTree.MAX_BYTES+1];var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    assertThrows(ApiError.class,()->service.preview(request,id,List.of("notes.txt"),List.of(),false));
    assertFalse(calls.stream().anyMatch(p->p.contains("/git/blobs/")));
  }
  @Test void anotherAccountSessionOrChangedGrantCannotReadSnapshot(){
    var service=service();String id=service.snapshot(request,"7","main").get("snapshotId").toString();
    when(auth.sessionBinding(request)).thenReturn("other-session");
    assertEquals("GITHUB_SNAPSHOT_EXPIRED",assertThrows(ApiError.class,()->service.tree(request,id,"")).code);
    when(auth.sessionBinding(request)).thenReturn("session");when(auth.credential(request)).thenReturn(new GitHubService.Credential("account","42","fixture","changed-grant"));
    assertThrows(ApiError.class,()->service.tree(request,id,""));
  }
}
