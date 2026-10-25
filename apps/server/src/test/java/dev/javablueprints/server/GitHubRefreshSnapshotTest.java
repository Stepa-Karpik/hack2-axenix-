package dev.javablueprints.server;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.util.List;
import org.junit.jupiter.api.Test;

class GitHubRefreshSnapshotTest {
  @Test void rotatingAccessTokenPreservesImmutableSnapshotWithinSameLogicalGrant(){
    var f=new GitHubRepositoryTest();var service=f.service();
    String snapshot=service.snapshot(f.request,"7","main").get("snapshotId").toString();
    when(f.auth.credential(f.request)).thenReturn(new GitHubService.Credential("account","42","rotated-access","grant"));
    var result=service.preview(f.request,snapshot,List.of("notes.txt"),List.of(),false);
    assertEquals("b".repeat(40),GitHubClient.object(result.get("provenance")).get("commitSha"));
  }
  @Test void reconnectChangesLogicalGrantAndRejectsOldSnapshotBeforeBlobReads(){
    var f=new GitHubRepositoryTest();var service=f.service();
    String snapshot=service.snapshot(f.request,"7","main").get("snapshotId").toString();
    when(f.auth.credential(f.request)).thenReturn(new GitHubService.Credential("account","42","new-consent","different-grant"));
    assertEquals("GITHUB_SNAPSHOT_EXPIRED",assertThrows(ApiError.class,()->service.preview(f.request,snapshot,List.of("notes.txt"),List.of(),false)).code);
    assertFalse(f.calls.stream().anyMatch(path->path.contains("/git/blobs/")));
  }
}
